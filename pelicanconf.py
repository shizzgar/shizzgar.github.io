#!/usr/bin/env python
# -*- coding: utf-8 -*- #
from __future__ import unicode_literals
import bulrush

AUTHOR = 'Sh!zZ'
SITENAME = 'КиберФизическиеСистемы'
SITEURL = ''


THEME = bulrush.PATH
JINJA_ENVIRONMENT = bulrush.ENVIRONMENT
JINJA_FILTERS = bulrush.FILTERS

PLUGIN_PATHS = ['pelican-plugins']
PLUGINS = ['assets']

SITESUBTITLE = "SLEEP MORE THAN STUDIE, STUDIE MORE THAN PARTY, PARTY AS YOU CAN "


PATH = 'content'

TIMEZONE = 'Europe/Moscow'

DEFAULT_LANG = 'ru'

# Feed generation is usually not desired when developing
FEED_ALL_ATOM = None
CATEGORY_FEED_ATOM = None
TRANSLATION_FEED_ATOM = None
AUTHOR_FEED_ATOM = None
AUTHOR_FEED_RSS = None

# Blogroll
LINKS = (('Pelican', 'http://getpelican.com/'),
         ('Python.org', 'http://python.org/'),
         ('Jinja2', 'http://jinja.pocoo.org/'),
         ('MIIGAiK', 'http://miigaik.ru/'),)

# Social widget
SOCIAL = (('VK', 'http://vk.com/'),
          ('INST', 'http://instagram.com/'),)

DEFAULT_PAGINATION = 4

# Uncomment following line if you want document-relative URLs when developing
RELATIVE_URLS = True

AUTHOR_SAVE_AS = ''
AUTHOR_URL = ''
YEAR_ARCHIVE_SAVE_AS = '{date:%Y}/index.html'


# STATIC_PATHS = [
#     'images',
#     'extra',
# ]
# EXTRA_PATH_METADATA = {
#     'extra/custom.css': {'path': 'custom.css'},
#     'extra/robots.txt': {'path': 'robots.txt'},
#     'extra/favicon.ico': {'path': 'favicon.ico'},
#     'extra/CNAME': {'path': 'CNAME'},
#     'extra/LICENSE': {'path': 'LICENSE'},
#     'extra/README': {'path': 'README'},
# }
