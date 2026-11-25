((script, load) => {
  load(script).catch((error) => {
    if (script.knBootSignal?.aborted) return;
    console.error('[ejs-loader]', error);
    script.dispatchEvent(new Event('error'));
  });
})(document.currentScript, async (script) => {
  const boot = script.knBootSignal;
  if (boot?.aborted) return;
  const scripts = [
    'emulator.js',
    'nipplejs.js',
    'shaders.js',
    'storage.js',
    'gamepad.js',
    'GameManager.js',
    'socket.io.min.js',
    'compression.js',
  ];

  const folderPath = (path) => path.substring(0, path.length - path.split('/').pop().length);
  let scriptPath =
    typeof window.EJS_pathtodata === 'string' ? window.EJS_pathtodata : folderPath(new URL(script.src).pathname);
  if (!scriptPath.endsWith('/')) scriptPath += '/';
  function assetReady(file, style) {
    const url =
      typeof window.EJS_paths?.[file] === 'string'
        ? window.EJS_paths[file]
        : (style || file.endsWith('emulator.min.js') ? scriptPath : scriptPath + 'src/') + file;
    const asset = document.createElement(style ? 'link' : 'script');
    if (style) {
      asset.rel = 'stylesheet';
      asset.href = url;
    } else {
      asset.src = url;
    }
    const key = style ? asset.href : asset.src;
    const existing = Array.from(document.head.querySelectorAll('[data-kn-ejs-asset]')).find(
      (el) => el.dataset.knEjsAsset === key,
    );
    if (existing) return existing.knEjsReady;

    // A removed script can still execute. Keep its request and result available
    // to the next boot so script globals are installed once, in source order.
    asset.dataset.knEjsAsset = key;
    if (scripts.includes(file)) asset.dataset.knEjsSource = file;
    const styleSignal = style ? boot : null;
    asset.knEjsReady = new Promise((resolve) => {
      const finish = (loaded) => {
        styleSignal?.removeEventListener('abort', discard);
        asset.onload = null;
        asset.onerror = null;
        if (!loaded) asset.remove();
        resolve(loaded);
      };
      const discard = () => finish(false);
      styleSignal?.addEventListener('abort', discard, { once: true });
      asset.onload = () => finish(true);
      asset.onerror = discard;
    });
    document.head.appendChild(asset);
    return asset.knEjsReady;
  }

  async function loadAsset(file, style) {
    if (boot?.aborted) throw boot.reason;
    const loaded = await assetReady(file, style);
    if (boot?.aborted) throw boot.reason;
    if (!loaded) await filesmissing(file);
  }

  const loadScript = (file) => loadAsset(file, false);
  const loadStyle = (file) => loadAsset(file, true);

  async function filesmissing(file) {
    console.error('Failed to load ' + file);
    let minifiedFailed = file.includes('.min.') && !file.includes('socket');
    console[minifiedFailed ? 'warn' : 'error'](
      'Failed to load ' +
        file +
        " beacuse it's likly that the minified files are missing.\nTo fix this you have 3 options:\n1. You can download the zip from the latest release here: https://github.com/EmulatorJS/EmulatorJS/releases/latest - Stable\n2. You can download the zip from here: https://cdn.emulatorjs.org/latest/data/emulator.min.zip and extract it to the data/ folder. (easiest option) - Beta\n3. You can build the files by running `npm i && npm run build` in the data/minify folder. (hardest option) - Beta\nNote: you will probably need to do the same for the cores, extract them to the data/cores/ folder.",
    );
    if (minifiedFailed) {
      console.log('Attempting to load non-minified files');
      if (file === 'emulator.min.js') {
        for (let i = 0; i < scripts.length; i++) {
          await loadScript(scripts[i]);
        }
      } else {
        await loadStyle('emulator.css');
      }
    } else {
      if (typeof KNEvent === 'function') KNEvent('wasm-fail', `Failed to load ${file}`, { file });
    }
  }

  const emulatorClassLoaded = typeof window.EmulatorJS === 'function';
  const debug = window.EJS_DEBUG_XX === true;
  // A cancelled source fallback may already have defined the constructor
  // while the remaining source files are still missing.
  if (document.head.querySelector('script[data-kn-ejs-source]')) {
    for (const file of scripts) await loadScript(file);
  } else if (!emulatorClassLoaded) {
    if (debug) {
      for (const file of scripts) await loadScript(file);
    } else {
      await loadScript('emulator.min.js');
    }
  }
  await loadStyle(debug ? 'emulator.css' : 'emulator.min.css');
  const config = {};
  config.gameUrl = window.EJS_gameUrl;
  config.dataPath = scriptPath;
  config.system = window.EJS_core;
  config.biosUrl = window.EJS_biosUrl;
  config.gameName = window.EJS_gameName;
  config.color = window.EJS_color;
  config.adUrl = window.EJS_AdUrl;
  config.adMode = window.EJS_AdMode;
  config.adTimer = window.EJS_AdTimer;
  config.adSize = window.EJS_AdSize;
  config.alignStartButton = window.EJS_alignStartButton;
  config.VirtualGamepadSettings = window.EJS_VirtualGamepadSettings;
  config.buttonOpts = window.EJS_Buttons;
  config.volume = window.EJS_volume;
  config.defaultControllers = window.EJS_defaultControls;
  config.startOnLoad = window.EJS_startOnLoaded;
  config.fullscreenOnLoad = window.EJS_fullscreenOnLoaded;
  config.filePaths = window.EJS_paths;
  config.loadState = window.EJS_loadStateURL;
  config.cacheLimit = window.EJS_CacheLimit;
  config.cheats = window.EJS_cheats;
  config.defaultOptions = window.EJS_defaultOptions;
  config.gamePatchUrl = window.EJS_gamePatchUrl;
  config.gameParentUrl = window.EJS_gameParentUrl;
  config.netplayUrl = window.EJS_netplayServer;
  // EJS expects gameId to be a number. Convert ROM hash to a numeric hash.
  const _gameIdStr = window.EJS_gameID || window.KNState?.romHash || 'kaillera-next';
  let _gameIdNum = 0;
  for (let i = 0; i < _gameIdStr.length; i++)
    _gameIdNum = ((_gameIdNum << 5) - _gameIdNum + _gameIdStr.charCodeAt(i)) | 0;
  config.gameId = Math.abs(_gameIdNum);
  config.backgroundImg = window.EJS_backgroundImage;
  config.backgroundBlur = window.EJS_backgroundBlur;
  config.backgroundColor = window.EJS_backgroundColor;
  config.controlScheme = window.EJS_controlScheme;
  config.threads = window.EJS_threads;
  config.disableCue = window.EJS_disableCue;
  config.startBtnName = window.EJS_startButtonName;
  config.softLoad = window.EJS_softLoad;
  config.capture = window.EJS_screenCapture;
  config.externalFiles = window.EJS_externalFiles;
  config.dontExtractBIOS = window.EJS_dontExtractBIOS;
  config.disableDatabases = window.EJS_disableDatabases;
  config.disableLocalStorage = window.EJS_disableLocalStorage;
  config.forceLegacyCores = window.EJS_forceLegacyCores;
  config.noAutoFocus = window.EJS_noAutoFocus;
  config.videoRotation = window.EJS_videoRotation;
  config.hideSettings = window.EJS_hideSettings;
  config.shaders = Object.assign({}, window.EJS_SHADERS, window.EJS_shaders ? window.EJS_shaders : {});

  let systemLang;
  try {
    systemLang = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch (e) {} //Ignore
  if (
    (typeof window.EJS_language === 'string' && window.EJS_language !== 'en-US') ||
    (systemLang && window.EJS_disableAutoLang !== false)
  ) {
    const language = window.EJS_language || systemLang;
    try {
      let path;
      console.log('Loading language', language);
      if ('undefined' != typeof EJS_paths && typeof EJS_paths[language] === 'string') {
        path = EJS_paths[language];
      } else {
        path = scriptPath + 'localization/' + language + '.json';
      }
      config.language = language;
      config.langJson = JSON.parse(await (await fetch(path)).text());
    } catch (e) {
      console.log('Missing language', language, '!!');
      delete config.language;
      delete config.langJson;
    }
  }

  if (boot?.aborted) return;
  window.EJS_emulator = new EmulatorJS(EJS_player, config);
  window.EJS_adBlocked = (url, del) => window.EJS_emulator.adBlocked(url, del);
  if (typeof window.EJS_ready === 'function') {
    window.EJS_emulator.on('ready', window.EJS_ready);
  }
  if (typeof window.EJS_onGameStart === 'function') {
    window.EJS_emulator.on('start', window.EJS_onGameStart);
  }
  if (typeof window.EJS_onLoadState === 'function') {
    window.EJS_emulator.on('loadState', window.EJS_onLoadState);
  }
  if (typeof window.EJS_onSaveState === 'function') {
    window.EJS_emulator.on('saveState', window.EJS_onSaveState);
  }
  if (typeof window.EJS_onLoadSave === 'function') {
    window.EJS_emulator.on('loadSave', window.EJS_onLoadSave);
  }
  if (typeof window.EJS_onSaveSave === 'function') {
    window.EJS_emulator.on('saveSave', window.EJS_onSaveSave);
  }
  script.dispatchEvent(new Event('kn-ejs-loader-complete'));
  window.dispatchEvent(new CustomEvent('kn-ejs-loader-complete'));
});
