const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  requestLanguage,
  requestLanguageFromUrl,
  withEditorLanguage
} = require('../build/src/language');
const { renderPlayerHtml } = require('../build/src/routes/player-html');
const createH5PConfig = require('../build/src/h5p/config').default;
const {
  default: createH5PEditor,
  createLibraryStorage
} = require('../build/src/h5p/editor');
const initI18n = require('../build/src/h5p/i18n').default;
const { tmpDir } = require('./helpers');
const { CORE, auth, rawGet, withHost } = require('./host');

for (const language of ['en', 'ru', 'es', 'ka']) {
  test(`${language} selects the interface language and survives the H5P AJAX model`, () => {
    assert.equal(requestLanguage(language), language);
    const model = withEditorLanguage(
      {
        scripts: [`${CORE}/h5p/editor/language/en.js?version=1`],
        integration: {
          ajaxPath: `${CORE}/h5p/ajax?action=`,
          editor: {
            ajaxPath: `${CORE}/h5p/ajax?token=abc&action=`,
            assets: { js: [`${CORE}/h5p/editor/language/en.js?version=1`] }
          }
        }
      },
      language
    );
    assert.equal(
      model.integration.ajaxPath,
      `${CORE}/h5p/ajax?lang=${language}&action=`
    );
    assert.equal(
      model.integration.editor.ajaxPath,
      `${CORE}/h5p/ajax?token=abc&lang=${language}&action=`
    );
    if (language === 'ka') {
      assert.equal(model.scripts.at(-1), `${CORE}/web/language/ka.js`);
      assert.equal(
        model.integration.editor.assets.js.at(-1),
        `${CORE}/web/language/ka.js`
      );
    } else if (language === 'ru' || language === 'es') {
      const translation = `${CORE}/h5p/editor/ckeditor/translations/${language}.js`;
      assert.equal(model.scripts.at(-1), translation);
      assert.equal(model.integration.editor.assets.js.at(-1), translation);
    } else {
      assert.equal(model.scripts.length, 1);
    }
    assert.match(
      renderPlayerHtml({ integration: {}, scripts: [], styles: [] }, language),
      new RegExp(`<html class="h5p-iframe" lang="${language}">`)
    );
  });
}

function playerWithContentLanguage(contentLanguage) {
  return renderPlayerHtml(
    {
      contentId: '7',
      integration: {
        contents: {
          'cid-7': { metadata: { defaultLanguage: contentLanguage } },
          'cid-8': { metadata: { defaultLanguage: 'ru' } }
        }
      },
      scripts: [],
      styles: []
    },
    'ka'
  );
}

test('player content keeps its own language independently of the UI language', () => {
  for (const language of ['en', 'de', 'de-DE', 'es-MX']) {
    const html = playerWithContentLanguage(language);
    assert.match(html, /<html class="h5p-iframe" lang="ka">/);
    assert.match(
      html,
      new RegExp(
        `<div class="h5p-content" data-content-id="7" lang="${language}">`
      )
    );
  }
  assert.match(
    playerWithContentLanguage(' de-DE '),
    /<div class="h5p-content" data-content-id="7" lang="de-DE">/
  );
});

test('player content falls back to English when its language is missing or invalid', () => {
  for (const language of [undefined, null, '', '  ', 42, [], {}]) {
    assert.match(
      playerWithContentLanguage(language),
      /<div class="h5p-content" data-content-id="7" lang="en">/
    );
  }
  for (const contents of [undefined, {}, { 'cid-7': {} }]) {
    assert.match(
      renderPlayerHtml(
        { contentId: '7', integration: { contents }, scripts: [], styles: [] },
        'ka'
      ),
      /<div class="h5p-content" data-content-id="7" lang="en">/
    );
  }
});

test('player content language is escaped as an HTML attribute', () => {
  const html = playerWithContentLanguage('" ><img src=x onerror=alert(1)>&');
  assert.match(
    html,
    /<div class="h5p-content" data-content-id="7" lang="&quot; &gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;">/
  );
  assert.doesNotMatch(html, /<img/);
});

test('missing, unsupported and malformed languages fall back to English', () => {
  for (const value of [undefined, '', 'xx', [], ['en', 'ru'], {}, '../ru']) {
    assert.equal(requestLanguage(value), 'en');
  }
  assert.equal(requestLanguage(' RU-ru '), 'ru');
  assert.equal(requestLanguage('ka_GE'), 'ka');
});

test('literal language queries match the browser despite nested-looking keys', () => {
  for (const query of [
    '?lang=ru&lang[other]=x',
    '?lang[other]=x&lang=ru',
    '?lang=ru&lang[]=es',
    '?lang=ru&lang[0]=es'
  ]) {
    assert.equal(requestLanguageFromUrl(`/editor/new${query}`), 'ru');
  }
  for (const query of [
    '',
    '?lang=',
    '?lang[]=ru',
    '?lang[name]=ru',
    '?lang=ru&lang=es'
  ]) {
    assert.equal(requestLanguageFromUrl(`/editor/new${query}`), 'en');
  }
  assert.equal(requestLanguageFromUrl('/editor/new?lang=ka-GE'), 'ka');
});

test('Georgian editor labels overlay English without discarding untranslated fields', () => {
  const core = { title: 'Title', untranslated: 'English fallback' };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../web/language/ka.js'), 'utf8'),
    { window: { H5PEditor: { language: { core } } } }
  );
  assert.equal(core.title, 'სათაური');
  assert.equal(core.saveLabel, 'შენახვა');
  assert.equal(core.untranslated, 'English fallback');
});

test('concurrent language requests reach editor, player and AJAX without changing the tenant', async () => {
  const languages = [];
  const context = {
    language_code: 'ru',
    paths: { content: '/tmp/dev1/content', tmp: '/tmp/dev1/tmp' },
    h5pEditor: {
      async render(_id, language) {
        await new Promise((resolve) => setImmediate(resolve));
        languages.push(['editor', language]);
        return { integration: {}, scripts: [], styles: [] };
      }
    },
    h5pPlayer: {
      async render(_id, _user, language) {
        await new Promise((resolve) => setImmediate(resolve));
        languages.push(['player', language]);
        return { integration: {}, scripts: [], styles: [] };
      }
    }
  };
  await withHost(
    async (port) => {
      const fallbackQueries = [
        '',
        '?lang=',
        '?lang=unknown',
        '?lang=ru&lang=es',
        '?lang[name]=ru'
      ];
      const queries = [
        ...['en', 'ru', 'es', 'ka'].map((language) => `?lang=${language}`),
        '?lang=ru&lang[other]=x',
        '?lang[other]=x&lang=ru',
        ...fallbackQueries
      ];
      const responses = await Promise.all(
        queries.flatMap((query) => [
          rawGet(port, `${CORE}/api/v1/content/new/edit${query}`, auth),
          rawGet(port, `${CORE}/api/v1/content/7/render${query}`, auth),
          rawGet(port, `${CORE}/h5p/ajax${query}`, auth)
        ])
      );
      for (const response of responses) assert.equal(response.status, 200);
      const expected = [
        ...['en', 'ru', 'es', 'ka'].flatMap((language) => [
          ['editor', language],
          ['player', language],
          ['ajax', language]
        ]),
        ...Array.from({ length: 2 }).flatMap(() => [
          ['editor', 'ru'],
          ['player', 'ru'],
          ['ajax', 'ru']
        ]),
        ...fallbackQueries.flatMap(() => [
          ['editor', 'en'],
          ['player', 'en'],
          ['ajax', 'en']
        ])
      ];
      assert.deepEqual(languages.sort(), expected.sort());
      assert.equal(context.language_code, 'ru');
    },
    {
      tenant: {
        context,
        async h5pRouter(req, res) {
          await new Promise((resolve) => setImmediate(resolve));
          languages.push(['ajax', req.language]);
          res.json({ language: req.language });
        }
      }
    }
  );
});

test('one real editor keeps core scripts, metadata and AJAX localized for simultaneous languages', async (t) => {
  const root = tmpDir(t, 'host-language-');
  for (const directory of ['libraries', 'content', 'tmp']) {
    fs.mkdirSync(path.join(root, directory));
  }
  const { translationCallback } = await initI18n('en', false);
  const h5pEditor = await createH5PEditor(
    createH5PConfig(),
    createLibraryStorage(path.join(root, 'libraries')),
    path.join(root, 'content'),
    path.join(root, 'tmp'),
    translationCallback,
    'https://host.test/editor'
  );
  const user = { id: 'dev1', name: 'dev', type: 'local', email: 'a@b.c' };
  const titles = { en: 'Title', ru: 'Заголовок', es: 'Título', ka: 'სათაური' };
  const models = await Promise.all(
    ['ru', 'es', 'ka', 'en', 'ka', 'ru'].map(async (language) => ({
      language,
      model: withEditorLanguage(
        await h5pEditor.render(undefined, language, user),
        language
      )
    }))
  );
  // Inspect after every render has finished: a shared translation state must
  // not change the models that earlier requests already received.
  for (const { language, model } of models) {
    const editor = model.integration.editor;
    assert.equal(editor.language, language);
    assert.equal(
      editor.metadataSemantics.find((field) => field.name === 'title').label,
      titles[language]
    );
    const coreLanguage = language === 'ka' ? 'en' : language;
    for (const scripts of [model.scripts, editor.assets.js]) {
      const coreScripts = scripts.filter((url) =>
        /\/h5p\/editor\/language\/[^/]+\.js$/.test(
          new URL(url, 'https://host.test').pathname
        )
      );
      assert.equal(coreScripts.length, 1);
      assert.equal(
        new URL(coreScripts[0], 'https://host.test').pathname,
        `${CORE}/h5p/editor/language/${coreLanguage}.js`
      );
      assert.equal(
        scripts.includes(`${CORE}/web/language/ka.js`),
        language === 'ka'
      );
      const richTextTranslations = scripts.filter((url) =>
        url.includes('/ckeditor/translations/')
      );
      assert.deepEqual(
        richTextTranslations,
        language === 'ru' || language === 'es'
          ? [`${CORE}/h5p/editor/ckeditor/translations/${language}.js`]
          : []
      );
    }
    for (const ajaxPath of [model.integration.ajaxPath, editor.ajaxPath]) {
      assert.ok(ajaxPath.endsWith('action='));
      const libraryRequest = new URL(
        ajaxPath + 'libraries',
        'https://host.test'
      );
      assert.equal(libraryRequest.searchParams.get('lang'), language);
      assert.equal(libraryRequest.searchParams.get('action'), 'libraries');
    }
  }
});

function hostLanguage(search) {
  const elements = new Map();
  const document = {
    documentElement: {},
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          setAttribute(name, value) {
            this[name] = value;
          }
        });
      }
      return elements.get(id);
    }
  };
  const source = fs
    .readFileSync(path.join(__dirname, '../web/host-language.js'), 'utf8')
    .replace(/^export /gm, '');
  const locale = vm.runInNewContext(
    source + '\n({ language, t, setLanguage })',
    {
      URLSearchParams,
      location: { search },
      document
    }
  );
  return { ...locale, document, elements };
}

test('host chrome translates loading and first-party failures with literal error details', () => {
  const labels = {
    en: {
      loading: 'Loading editor…',
      upgrade: 'Upgrade',
      error: 'Editor service request failed (503).'
    },
    ru: {
      loading: 'Загрузка редактора…',
      upgrade: 'Обновить',
      error: 'Запрос к сервису редактора завершился ошибкой (503).'
    },
    es: {
      loading: 'Cargando el editor…',
      upgrade: 'Actualizar',
      error: 'Falló la solicitud al servicio del editor (503).'
    },
    ka: {
      loading: 'რედაქტორი იტვირთება…',
      upgrade: 'განახლება',
      error: 'რედაქტორის სერვისის მოთხოვნა ვერ შესრულდა (503).'
    }
  };
  const details = '<img src=x onerror=alert(1)> {status} $&';
  for (const [language, expected] of Object.entries(labels)) {
    const locale = hostLanguage(`?lang=${language}`);
    locale.setLanguage();
    assert.equal(locale.document.documentElement.lang, language);
    assert.equal(
      locale.elements.get('host-loading').textContent,
      expected.loading
    );
    assert.equal(
      locale.elements.get('host-upgrade-button').textContent,
      expected.upgrade
    );
    assert.equal(
      locale.t('Editor service request failed ({status}).', { status: 503 }),
      expected.error
    );
    const source = 'The editor could not load its libraries ({reason}).';
    const message = locale.t(source, { reason: details, status: 'replaced' });
    assert.ok(message.includes(details));
    assert.ok(!message.includes('{reason}'));
    if (language !== 'en')
      assert.notEqual(message, source.replace('{reason}', details));
    assert.equal(locale.t('{value} {missing}', { value: 0 }), '0 {missing}');
    assert.equal(locale.t('{value}', { value: false }), 'false');
    assert.equal(locale.t(undefined), undefined);
  }
});
