import { getLanguage } from './i18n.js?v=20261103-runtime-4';
import { runtimeTranslations, runtimePatterns } from './runtime-translations.js?v=20261103-runtime-4';

// Translate only known interface messages. User prompts, generated source and
// unknown browser/model diagnostics pass through unchanged.
const messages = {
  'Не удалось завершить загрузку сцены. Повторно запускаю тот же HTML без генерации модели.':'Scene loading did not complete. Retrying the same HTML without generating it again.',
  'Повторно запускаю сохранённый HTML без генерации модели.':'Running the saved HTML again without model generation.',
  'ТЫ':'YOU',
  'FORMA · ПРОВЕРКА':'FORMA · CHECK',
  'FORMA · ИСПРАВЛЯЮ':'FORMA · REPAIR',
  'FORMA · СОЗДАЮ':'FORMA · GENERATING',
  'FORMA · МОДЕЛЬ ГОТОВА':'FORMA · MODEL READY',
  'FORMA · ЛОКАЛЬНАЯ МОДЕЛЬ':'FORMA · LOCAL MODEL',
  'Изображение-референс прикреплено':'Reference image attached',
  'Останавливаю…':'Stopping…',
  'Остановить':'Stop',
  'Остановка запрошена':'Stop requested',
  'Если компонент модели ещё загружается, остановка произойдёт после текущего этапа.':'If a model component is still loading, the operation will stop after this step.',
  'Не удалось завершить движок · повторим остановку':'Engine shutdown failed · will retry',
  'Движок модели остановлен · восстановится перед запросом':'Model engine paused · resumes before the next request',
  'Модель не загружена':'Model not loaded',
  'Локальная модель':'Local model',
  'Модель':'Model',
  'текст и картинки':'text and images',
  'текст':'text',
  ' · GPU запрошен':' · GPU requested',
  ' · веса: WebGPU + CPU (по журналу)':' · weights: WebGPU + CPU (engine log)',
  ' · веса: WebGPU (по журналу)':' · weights: WebGPU (engine log)',
  ' · веса: CPU (по журналу)':' · weights: CPU (engine log)',
  'Ожидание данных…':'Waiting for data…',
  'Опиши свою идею...':'Describe your scene or what to change…',
  'Опиши сцену или что изменить…':'Describe your scene or what to change…',
  'Загрузи модель, чтобы начать…':'Load the model to begin…',
  'Подготавливаем комплект…':'Preparing the bundle…',
  'Скачиваем комплект…':'Downloading the bundle…',
  'ZIP сохранён. Распакуй его перед загрузкой частей в Forma.':'ZIP saved. Extract it before selecting the model parts in Forma.',
  'Скачивание отменено.':'Download cancelled.',
  'ZIP архив':'ZIP archive',
  'Этот браузер не поддерживает сохранение большого ZIP напрямую. Попробуй актуальный Chrome или Edge; ниже доступны отдельные файлы.':'This browser cannot save a large ZIP directly. Try a current Chrome or Edge version, or use the individual files below.',
  'Проверка 3D-сцены':'3D scene check',
  'Предпросмотр 3D-сцены':'3D scene preview',
  'Предпросмотр сгенерированной 3D-сцены':'Generated 3D scene preview',
  'Освобождение сцены':'Releasing the scene',
  'Сцена временно приостановлена для модели':'Scene paused while the model runs',
  'Освобождаю ресурсы сцены':'Releasing scene resources',
  'HTML сохранён; предпросмотр будет восстановлен после генерации.':'HTML saved; the preview will return after generation.',
  'Восстанавливаю модель':'Resuming the model',
  'Файлы модели используются повторно; для движка может понадобиться доступ к CDN.':'Model files are reused; the runtime may still need access to its CDN.',
  'Восстанавливаем модель из сохранённых файлов…':'Resuming the model from retained files…',
  'Освобождаю ресурсы модели':'Releasing model resources',
  'Выгружаю модель перед запуском сцены; её файлы сохранены для следующего запроса.':'Stopping the model before rendering; its files are retained for the next request.',
  'Сначала загрузи модель кнопкой выше.':'Load the model first using the button above.',
  'предпросмотр не прошёл проверку':'the preview did not pass validation',
  'Не удалось восстановить предпросмотр; HTML сохранён':'Preview could not be restored; HTML retained',
  'Не удалось восстановить предыдущую сцену':'Previous scene could not be restored',
  'Предыдущая сцена восстановлена':'Previous scene restored',
  'HTML запущен повторно.':'HTML was run again.',
  'Частичный кадр · сцена не прошла проверку':'Partial frame · scene did not pass validation',
  'Частичный кадр':'Partial frame',
  'Показан статичный кадр; проверка сцены не пройдена и визуальное качество не подтверждено.':'A still frame is shown. The scene did not pass validation; visual quality is unverified.',
  'Частичный кадр недоступен':'Partial frame unavailable',
  'Не удалось получить кадр из последнего варианта сцены.':'Could not capture a frame from the latest scene.',
  'Проверен запуск сцены':'Scene startup checked',
  'Генерация модели':'Model generation',
  'Достигнут лимит вывода или контекста':'Output or context limit reached',
  'Запрос, изображения, размышления и ответ занимают общее окно контекста. Часть окна уже занята входными данными.':'The prompt, images, reasoning and response share one context window. Input already occupies part of it.',
  'Запуск и проверка сцены':'Run and validate the scene',
  'Ошибка во время работы сцены':'Scene runtime error',
  'Потерян контекст WebGL':'WebGL context lost',
  'Проверяю восстановление WebGL':'Checking WebGL recovery',
  'Пробую создать небольшой тестовый контекст после освобождения сцены.':'Trying a small test context after releasing the scene.',
  'Сейчас не удалось создать тестовый WebGL-контекст. Автоматическое исправление остановлено: повторный запуск сцены пока не подтверждён.':'A test WebGL context could not be created. Automatic repair has stopped because rendering is not currently available.',
  'WebGL пока недоступен':'WebGL currently unavailable',
  'Тестовый WebGL-контекст создан':'Test WebGL context created',
  'Это не гарантирует запуск сгенерированной сцены.':'This does not guarantee that the generated scene will run.',
  'Проверка WebGL не дала результата':'WebGL check was inconclusive',
  'Причина потери контекста остаётся неизвестной.':'The cause of context loss is still unknown.',
  'Проверка не прошла':'Validation failed',
  'Ошибка выполнения сцены.':'Scene runtime error.',
  'Сцена сообщила об ошибке после запуска. Исправляю её…':'The scene reported an error after startup. Repairing it…',
  'Исправляю ошибку сцены…':'Repairing the scene…',
  'Поздняя ошибка':'Late runtime error',
  'Ошибка исправлена и запуск сцены проверен.':'The error was repaired and scene startup checked.',
  'Исправлено':'Repaired',
  'Готово':'Done',
  'Готово ✓':'Ready ✓',
  'Ошибка':'Error',
  'Остановлено':'Stopped',
  'Исправление остановлено.':'Repair stopped.',
  'Автоматически исправить сцену не удалось.':'Automatic scene repair failed.',
  'Не удалось исправить сцену':'Scene repair failed',
  'Не удалось исправить ошибку.':'Could not repair the error.',
  'Сцена изменилась во время исправления.':'The scene changed during repair.',
  'Подготавливаем загрузку…':'Preparing to load…',
  'Опиши сцену. Для первого запроса с картинкой понадобится дополнительная загрузка.':'Describe a scene. Your first image request needs an additional download.',
  'Не удалось загрузить модель':'Model loading failed',
  'Проверяем доступ с твоего устройства…':'Checking access from your device…',
  'Проверяю адаптер WebGPU…':'Checking the WebGPU adapter…',
  'Не удалось проверить адаптер WebGPU.':'Could not check the WebGPU adapter.',
  'адаптер недоступен':'adapter unavailable',
  'WebGPU API недоступен':'WebGPU API unavailable',
  'не удалось проверить':'could not verify',
  'время ожидания истекло':'timed out',
  'проверка не поддерживается':'check unsupported',
  'неизвестно':'unknown',
  'доступен':'available',
  'недоступен':'unavailable',
  'Не удалось проверить WebGPU. В Chrome открой chrome://gpu, в Edge — edge://gpu.':'Could not check WebGPU. Open chrome://gpu in Chrome or edge://gpu in Edge.',
  'shader-f16 необходим WebGPU-бэкенду текущего движка. Тестовый worker не является worker модели: результаты не подтверждают загрузку весов на GPU.':'The current engine’s WebGPU backend requires shader-f16. The test worker is not the model worker: its result does not confirm that weights are on GPU.',
  'Это проверка соединения, а не гарантия полной загрузки.':'This checks connectivity; it does not guarantee that the full model can be downloaded.',
  'Подготавливаем файлы…':'Preparing the files…',
  'Загрузить ↗':'Load ↗',
  'Можно описать сцену или приложить картинку.':'Describe a scene or attach an image.',
  'Можно создавать сцены по тексту. Для картинки выбери файл mmproj в разделе своих файлов.':'You can create scenes from text. For images, select an mmproj file in model settings.',
  'Готовлю сцену…':'Preparing the scene…',
  'Генерирую сцену · показан предыдущий частичный кадр':'Generating · previous partial frame shown',
  'Генерирую сцену…':'Generating the scene…',
  'Запрос пользователя':'User request',
  'Для картинки выбери файл mmproj в разделе «Свои файлы модели».':'For image input, select an mmproj file under local model files.',
  'Создание сцены остановлено.':'Scene creation stopped.',
  'Загружаю компонент для картинок и перезапускаю модель…':'Loading the image component and restarting the model…',
  'Подготавливаем компонент для картинок…':'Preparing the image component…',
  'Подключение vision':'Enable image input',
  'Компонент для картинок подключён.':'Image component enabled.',
  'Проверка не завершилась успешно.':'Validation did not finish successfully.',
  'Проверенная сцена недоступна для предпросмотра.':'The validated scene is unavailable for preview.',
  'Сцена запущена, ошибок за время проверки не обнаружено. Внешний вид и соответствие запросу автоматически не подтверждены.':'The scene is running; no errors were observed during validation. Appearance and prompt alignment have not been verified automatically.',
  'Сцена запущена; ошибок за время проверки не обнаружено.':'The scene is running; no errors were observed during validation.',
  'Не получилось создать и проверить сцену.':'Could not create and validate the scene.',
  'Предыдущая сцена сохранена':'Previous scene retained',
  'Предыдущая сцена сохранена.':'Previous scene retained.',
  'Сцена пока не создана':'No scene yet',
  'Сцена пока не создана.':'No scene yet.',
  'Не удалось завершить':'Could not finish',
  'Поддерживаются JPG, PNG и WEBP.':'JPG, PNG and WEBP are supported.',
  'Изображение должно быть не больше 10 МБ.':'The image must be 10 MB or smaller.',
  'Повторная проверка':'Recheck the scene',
  'Повторно запускаю сохранённый HTML без генерации модели.':'Running the retained HTML first, without model generation.',
  'Проверяю сохранённую сцену…':'Checking the retained scene…',
  'Повторно проверяю сцену…':'Rechecking the scene…',
  'Сцена не прошла проверку запуска.':'The scene did not pass startup validation.',
  'Для исправления сцены сначала загрузи модель. HTML сохранён.':'Load the model to repair this scene. HTML has been retained.',
  'Исходный запрос для исправления недоступен. HTML сохранён.':'The original prompt is unavailable for repair. HTML has been retained.',
  'Для исправления с изображением выбери компонент mmproj. HTML сохранён.':'Select an mmproj component to repair with image input. HTML has been retained.',
  'Проверка обнаружила ошибки. Восстанавливаю модель для исправления…':'Validation found errors. Resuming the model to repair them…',
  'Исправление':'Repair',
  'Проверка нашла ошибки; передаю их модели вместе с сохранённым HTML.':'Validation found errors; sending them to the model with the retained HTML.',
  'Не удалось исправить сцену. HTML сохранён.':'Could not repair the scene. HTML has been retained.',
  'Проверка остановлена; HTML сохранён.':'Validation stopped; HTML retained.',
  'Сцена не прошла повторную проверку; HTML сохранён.':'The scene did not pass revalidation; HTML retained.',
  'Повторная проверка не прошла':'Revalidation failed',
  'Твоя сцена появится здесь':'Your scene will appear here',
  'Скопировано ✓':'Copied ✓',
  'Копировать':'Copy',
  'Не удалось скопировать код. Используй кнопку HTML для скачивания.':'Could not copy the code. Use the HTML download button.',
};

const patterns = [
  [/^(Локальная модель|Модель): (текст и картинки|текст)(.*)$/s, (name, modality, backend) => `${messages[name]}: ${messages[modality]}${translateShell(backend, 'en')}`],
  [/^Создаю сцену · попытка (.+)…$/, attempt => `Creating the scene · attempt ${attempt}…`],
  [/^Пишу код · попытка (.+) · (\d+) символов$/, (attempt, count) => `Writing code · attempt ${attempt} · ${count} characters`],
  [/^Проверяю структуру кода · попытка (.+)…$/, attempt => `Checking document structure · attempt ${attempt}…`],
  [/^Запускаю сцену и проверяю ошибки · попытка (.+)…$/, attempt => `Running and validating · attempt ${attempt}…`],
  [/^Исправляю ошибки · следующая попытка (.+)…$/, attempt => `Repairing errors · next attempt ${attempt}…`],
  [/^Не удалось подтвердить освобождение ресурсов: (.*)$/s, detail => `Could not confirm resource release: ${detail}`],
  [/^Браузер или устройство потеряло контекст WebGL: (.*)$/s, detail => `The browser or device lost its WebGL context: ${detail}`],
  [/^Сцена снова сообщила об ошибке после автоматического исправления: (.*)$/s, detail => `The scene reported another error after automatic repair: ${detail}`],
  [/^Ошибка исправлена; замечание проверки: (.*)$/s, detail => `The error was repaired; validation note: ${detail}`],
  [/^Не удалось исправить ошибку: (.*)$/s, detail => `Could not repair the error: ${detail}`],
  [/^Сцена запущена\. Замечание проверки: (.*)$/s, detail => `Scene running. Validation note: ${detail}`],
  [/^Не удалось получить рабочую сцену за (\d+) попыток\. (.*)$/s, (count, detail) => `Could not produce a working scene in ${count} attempts. ${detail}`],
  [/^Достигнут лимит вывода или контекста до получения полного HTML\. Полученные фрагменты доступны в трассе[.;] (.*)$/s, suffix => `The output or context limit was reached before a complete HTML document. Received fragments remain in the trace. ${translateShell(suffix, 'en')}`],
  [/^Достигнут лимит вывода или контекста до получения полного HTML\. Полученные фрагменты доступны в трассе; предыдущая сцена сохранена\.$/, () => 'The output or context limit was reached before a complete HTML document. Received fragments remain in the trace; the previous scene was retained.'],
  [/^Получено (.+) · общий размер неизвестен(.*)$/, (received, cached) => `Received ${received} · total size unknown${translateShell(cached, 'en')}`],
  [/^(.+) из (.+) · (\d+)%(.*)$/, (received, total, percent, cached) => `${received} of ${total} · ${percent}%${translateShell(cached, 'en')}`],
  [/^ · сохранено (.+)$/, value => ` · cached ${value}`],
  [/^адаптер доступен; shader-f16: (.+)$/, value => `adapter available; shader-f16: ${translateShell(value, 'en')}`],
  [/^Окно браузера: (.*)\.$/, detail => `Browser window: ${translateShell(detail, 'en')}.`],
  [/^Тестовый worker: (.*)\.$/, detail => `Test worker: ${translateShell(detail, 'en')}.`],
  [/^Не удалось выполнить проверку: (.*)$/s, detail => `Could not complete the check: ${detail}`],
  [/^(.+): (доступен|не удалось проверить) — (.*)$/, (name, state, detail) => `${translateShell(name, 'en')}: ${translateShell(state, 'en')} — ${translateShell(detail, 'en')}`],
];

export function translateShell(value, language = getLanguage()) {
  const source = String(value ?? '');
  if (language !== 'en' || !source) return source;
  if (Object.hasOwn(messages, source)) return messages[source];
  if (Object.hasOwn(runtimeTranslations, source)) return runtimeTranslations[source];
  for (const [pattern, render] of [...patterns, ...runtimePatterns]) {
    const match = pattern.exec(source);
    if (match) return render(...match.slice(1));
  }
  // Multiline diagnostics retain each unknown raw line exactly.
  if (source.includes('\n')) return source.split('\n').map(line => translateShell(line, language)).join('\n');
  return source;
}

export function createShellTextManager() {
  const nodes = new Map();
  const attributes = new Map();
  return {
    set(node, value) {
      if (!node) return;
      const source = String(value ?? '');
      nodes.set(node, source);
      node.textContent = translateShell(source);
    },
    source(node) { return nodes.get(node) ?? node?.textContent ?? ''; },
    attribute(node, name, value) {
      if (!node) return;
      const record = attributes.get(node) || new Map();
      record.set(name, String(value ?? '')); attributes.set(node, record);
      node.setAttribute(name, translateShell(value));
    },
    refresh() {
      for (const [node, source] of nodes) node.textContent = translateShell(source);
      for (const [node, record] of attributes) for (const [name, source] of record) node.setAttribute(name, translateShell(source));
    },
  };
}
