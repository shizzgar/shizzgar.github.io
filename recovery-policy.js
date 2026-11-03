// A pure decision table for failed scene validation. It does not edit source,
// invoke a model, allocate graphics resources, or guess at a driver's memory.
export const MAX_RUNTIME_RETRIES = 1;
export const MAX_PRESENTATION_RETRIES = 1;
export const MAX_RECOVERY_RESTARTS = 2;

const runtimeFailures = new Set(['module-load', 'resource', 'startup-timeout']);
const codeKinds = new Set(['script', 'promise', 'console', 'policy', 'webgl-error']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const decision = (action, reason, diagnosis = '') => ({action, reason, ...(diagnosis ? {diagnosis} : {})});

function schedulerEvidence(evidence) {
  const value = evidence?.scheduler;
  if (!value || typeof value !== 'object') return null;
  const validCount = key => Number.isSafeInteger(value[key]) && value[key] >= 0;
  if (!['requested','callbacks','pending'].every(validCount)) return null;
  return value;
}

function firstFrameDiagnosis(scheduler) {
  if (scheduler?.pending > 0 && scheduler.callbacks === 0) {
    return 'WebGL-контекст создан, но ожидающие requestAnimationFrame не выполнили ни одного callback после восстановления запуска. Обеспечь первый renderer.render(scene, camera) сразу после построения сцены и настройки камеры, затем запускай анимационный цикл. Сохрани исходную сцену и её возможности.';
  }
  if (scheduler?.callbacks > 0) {
    return 'Callback анимации выполнялся, но WebGL draw-вызовов не обнаружено даже после повторного запуска. Проверь вызов renderer.render(scene, camera), камеру, видимость объектов и начало цикла; выполни первый render после построения сцены. Сохрани исходную сцену и её возможности.';
  }
  return 'WebGL-контекст доступен, но первый кадр не нарисован после повторного запуска. Проверь запуск renderer.render(scene, camera), камеру и видимость объектов; выполни первый render сразу после построения сцены, затем запускай анимацию. Сохрани исходную сцену и её возможности.';
}

/**
 * Decide the next step for one generated candidate.
 *
 * Budgets are per candidate: one infrastructure restart, one presentation
 * restart, at most two total. The caller increments a counter only after it
 * actually chooses that restart. Genuine source errors never receive a
 * presentation restart. Context loss keeps its dedicated probe/repair path;
 * this policy returns stop without changing its existing validation flags.
 */
export function planValidationRecovery(validation, state = {}) {
  if (!validation || typeof validation.ok !== 'boolean') return decision('stop', 'invalid-validation');
  if (validation.ok) return decision('accept', 'validated');
  if (validation.contextLost === true) return decision('stop', 'webgl-context-lost');

  const runtimeRetries = count(state?.runtimeRetries);
  const presentationRetries = count(state?.presentationRetries);
  // A stale aggregate cannot accidentally reopen a budget already consumed by
  // the individual counters, including when a failure changes category.
  const restarts = Math.max(count(state?.restarts), runtimeRetries + presentationRetries);
  const diagnostics = Array.isArray(validation.diagnostics) ? validation.diagnostics : [];
  const sourceError = diagnostics.some(item => codeKinds.has(item?.kind));
  const policyError = diagnostics.some(item => item?.kind === 'policy');
  if (policyError) return decision('repair-code', 'script-policy');

  const runtimeFailure = validation.infrastructureFailure;
  if (runtimeFailures.has(runtimeFailure)) {
    // An actual script exception at a deadline is already a useful repair
    // target; a timeout must not conceal it behind a generic network retry.
    if (runtimeFailure === 'startup-timeout' && sourceError) return decision('repair-code', 'script-error');
    if (runtimeRetries < MAX_RUNTIME_RETRIES && restarts < MAX_RECOVERY_RESTARTS) return decision('retry-runtime', runtimeFailure);
    return decision('stop', 'runtime-recovery-exhausted');
  }
  // Examples include an unavailable WebGL implementation. Do not ask the
  // model to rewrite code to compensate for an explicitly unavailable runtime.
  if (validation.infrastructureErrorOther === true) return decision('stop', 'runtime-unavailable');
  if (sourceError) return decision('repair-code', 'script-error');

  const evidence = validation.evidence;
  const noFirstFrame = evidence?.visibleCanvasCount > 0 && evidence.webglContexts > 0 &&
    evidence.drawCalls === 0 && evidence.drawObservationAvailable === true;
  if (noFirstFrame) {
    const scheduler = schedulerEvidence(evidence);
    const reason = scheduler?.documentVisibility === 'hidden' ? 'document-hidden'
      : scheduler?.pending > 0 && scheduler.callbacks === 0 ? 'animation-frame-starved'
      : scheduler?.callbacks > 0 ? 'draw-not-observed' : 'first-frame-absent';
    if (presentationRetries < MAX_PRESENTATION_RETRIES && restarts < MAX_RECOVERY_RESTARTS) return decision('retry-presentation', reason);
    // Background scheduling says nothing about the source's correctness.
    // The caller can resume a foreground check later without regenerating it.
    if (reason === 'document-hidden') return decision('stop', reason,
      'Проверка отрисовки не завершена: документ был скрыт. Сохрани HTML и повтори проверку в активной вкладке; отсутствие кадра в фоне не доказывает ошибку сцены.');
    return decision('repair-code', reason, firstFrameDiagnosis(scheduler));
  }
  if (validation.retryable === false) return decision('stop', 'validation-unavailable');
  return decision('repair-code', 'validation-error');
}
