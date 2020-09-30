"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.XCUITestDriver = exports.default = void 0;

require("source-map-support/register");

var _appiumBaseDriver = require("appium-base-driver");

var _appiumSupport = require("appium-support");

var _lodash = _interopRequireDefault(require("lodash"));

var _url = _interopRequireDefault(require("url"));

var _nodeSimctl = require("node-simctl");

var _webdriveragent = _interopRequireDefault(require("./wda/webdriveragent"));

var _logger = _interopRequireDefault(require("./logger"));

var _simulatorManagement = require("./simulator-management");

var _appiumIosSimulator = require("appium-ios-simulator");

var _asyncbox = require("asyncbox");

var _appiumIosDriver = require("appium-ios-driver");

var _desiredCaps = require("./desired-caps");

var _index = _interopRequireDefault(require("./commands/index"));

var _utils = require("./utils");

var _realDeviceManagement = require("./real-device-management");

var _bluebird = _interopRequireDefault(require("bluebird"));

var _asyncLock = _interopRequireDefault(require("async-lock"));

var _path = _interopRequireDefault(require("path"));

var _appiumIdb = _interopRequireDefault(require("appium-idb"));

var _deviceConnectionsFactory = _interopRequireDefault(require("./device-connections-factory"));

const SHUTDOWN_OTHER_FEAT_NAME = 'shutdown_other_sims';
const SAFARI_BUNDLE_ID = 'com.apple.mobilesafari';
const WDA_SIM_STARTUP_RETRIES = 2;
const WDA_REAL_DEV_STARTUP_RETRIES = 1;
const WDA_REAL_DEV_TUTORIAL_URL = 'https://github.com/appium/appium-xcuitest-driver/blob/master/docs/real-device-config.md';
const WDA_STARTUP_RETRY_INTERVAL = 10000;
const DEFAULT_SETTINGS = {
  nativeWebTap: false,
  useJSONSource: false,
  shouldUseCompactResponses: true,
  elementResponseAttributes: 'type,label',
  mjpegServerScreenshotQuality: 25,
  mjpegServerFramerate: 10,
  screenshotQuality: 1,
  mjpegScalingFactor: 100,
  reduceMotion: null
};
const SHARED_RESOURCES_GUARD = new _asyncLock.default();
const NO_PROXY_NATIVE_LIST = [['DELETE', /window/], ['GET', /^\/session\/[^\/]+$/], ['GET', /alert_text/], ['GET', /alert\/[^\/]+/], ['GET', /appium/], ['GET', /attribute/], ['GET', /context/], ['GET', /location/], ['GET', /log/], ['GET', /screenshot/], ['GET', /size/], ['GET', /source/], ['GET', /timeouts$/], ['GET', /url/], ['GET', /window/], ['POST', /accept_alert/], ['POST', /actions$/], ['POST', /alert_text/], ['POST', /alert\/[^\/]+/], ['POST', /appium/], ['POST', /appium\/device\/is_locked/], ['POST', /appium\/device\/lock/], ['POST', /appium\/device\/unlock/], ['POST', /back/], ['POST', /clear/], ['POST', /context/], ['POST', /dismiss_alert/], ['POST', /element\/active/], ['POST', /element$/], ['POST', /elements$/], ['POST', /execute/], ['POST', /keys/], ['POST', /log/], ['POST', /moveto/], ['POST', /receive_async_response/], ['POST', /session\/[^\/]+\/location/], ['POST', /shake/], ['POST', /timeouts/], ['POST', /touch/], ['POST', /url/], ['POST', /value/], ['POST', /window/]];
const NO_PROXY_WEB_LIST = [['DELETE', /cookie/], ['GET', /attribute/], ['GET', /cookie/], ['GET', /element/], ['GET', /text/], ['GET', /title/], ['POST', /clear/], ['POST', /click/], ['POST', /cookie/], ['POST', /element/], ['POST', /forward/], ['POST', /frame/], ['POST', /keys/], ['POST', /refresh/]].concat(NO_PROXY_NATIVE_LIST);
const MEMOIZED_FUNCTIONS = ['getStatusBarHeight', 'getDevicePixelRatio', 'getScreenInfo', 'getSafariIsIphone', 'getSafariIsIphoneX'];

class XCUITestDriver extends _appiumBaseDriver.BaseDriver {
  constructor(opts = {}, shouldValidateCaps = true) {
    super(opts, shouldValidateCaps);
    this.desiredCapConstraints = _desiredCaps.desiredCapConstraints;
    this.locatorStrategies = ['xpath', 'id', 'name', 'class name', '-ios predicate string', '-ios class chain', 'accessibility id'];
    this.webLocatorStrategies = ['link text', 'css selector', 'tag name', 'link text', 'partial link text'];
    this.resetIos();
    this.settings = new _appiumBaseDriver.DeviceSettings(DEFAULT_SETTINGS, this.onSettingsUpdate.bind(this));
    this.logs = {};

    for (const fn of MEMOIZED_FUNCTIONS) {
      this[fn] = _lodash.default.memoize(this[fn]);
    }
  }

  async onSettingsUpdate(key, value) {
    if (key !== 'nativeWebTap') {
      return await this.proxyCommand('/appium/settings', 'POST', {
        settings: {
          [key]: value
        }
      });
    }

    this.opts.nativeWebTap = !!value;
  }

  resetIos() {
    this.opts = this.opts || {};
    this.wda = null;
    this.opts.device = null;
    this.jwpProxyActive = false;
    this.proxyReqRes = null;
    this.jwpProxyAvoid = [];
    this.safari = false;
    this.cachedWdaStatus = null;
    this.curWebFrames = [];
    this.webElementIds = [];
    this._currentUrl = null;
    this.curContext = null;
    this.xcodeVersion = {};
    this.contexts = [];
    this.implicitWaitMs = 0;
    this.asynclibWaitMs = 0;
    this.pageLoadMs = 6000;
    this.landscapeWebCoordsOffset = 0;
  }

  get driverData() {
    return {};
  }

  async getStatus() {
    if (typeof this.driverInfo === 'undefined') {
      this.driverInfo = await (0, _utils.getDriverInfo)();
    }

    let status = {
      build: {
        version: this.driverInfo.version
      }
    };

    if (this.cachedWdaStatus) {
      status.wda = this.cachedWdaStatus;
    }

    return status;
  }

  async createSession(...args) {
    this.lifecycleData = {};

    try {
      let [sessionId, caps] = await super.createSession(...args);
      this.opts.sessionId = sessionId;
      await this.start();
      caps = Object.assign({}, _appiumIosDriver.defaultServerCaps, caps);
      caps.udid = this.opts.udid;

      if (_lodash.default.has(this.opts, 'nativeWebTap')) {
        await this.updateSettings({
          nativeWebTap: this.opts.nativeWebTap
        });
      }

      if (_lodash.default.has(this.opts, 'useJSONSource')) {
        await this.updateSettings({
          useJSONSource: this.opts.useJSONSource
        });
      }

      let wdaSettings = {
        elementResponseAttributes: DEFAULT_SETTINGS.elementResponseAttributes,
        shouldUseCompactResponses: DEFAULT_SETTINGS.shouldUseCompactResponses
      };

      if (_lodash.default.has(this.opts, 'elementResponseAttributes')) {
        wdaSettings.elementResponseAttributes = this.opts.elementResponseAttributes;
      }

      if (_lodash.default.has(this.opts, 'shouldUseCompactResponses')) {
        wdaSettings.shouldUseCompactResponses = this.opts.shouldUseCompactResponses;
      }

      if (_lodash.default.has(this.opts, 'mjpegServerScreenshotQuality')) {
        wdaSettings.mjpegServerScreenshotQuality = this.opts.mjpegServerScreenshotQuality;
      }

      if (_lodash.default.has(this.opts, 'mjpegServerFramerate')) {
        wdaSettings.mjpegServerFramerate = this.opts.mjpegServerFramerate;
      }

      if (_lodash.default.has(this.opts, 'screenshotQuality')) {
        _logger.default.info(`Setting the quality of phone screenshot: '${this.opts.screenshotQuality}'`);

        wdaSettings.screenshotQuality = this.opts.screenshotQuality;
      }

      await this.updateSettings(wdaSettings);

      if (this.opts.mjpegScreenshotUrl) {
        _logger.default.info(`Starting MJPEG stream reading URL: '${this.opts.mjpegScreenshotUrl}'`);

        this.mjpegStream = new _appiumSupport.mjpeg.MJpegStream(this.opts.mjpegScreenshotUrl);
        await this.mjpegStream.start();
      }

      return [sessionId, caps];
    } catch (e) {
      _logger.default.error(e);

      await this.deleteSession();
      throw e;
    }
  }

  async start() {
    this.opts.noReset = !!this.opts.noReset;
    this.opts.fullReset = !!this.opts.fullReset;
    await (0, _utils.printUser)();
    this.opts.iosSdkVersion = null;
    const {
      device,
      udid,
      realDevice
    } = await this.determineDevice();

    _logger.default.info(`Determining device to run tests on: udid: '${udid}', real device: ${realDevice}`);

    this.opts.device = device;
    this.opts.udid = udid;
    this.opts.realDevice = realDevice;
    const normalizedVersion = (0, _utils.normalizePlatformVersion)(this.opts.platformVersion);

    if (this.opts.platformVersion !== normalizedVersion) {
      _logger.default.info(`Normalized platformVersion capability value '${this.opts.platformVersion}' to '${normalizedVersion}'`);

      this.opts.platformVersion = normalizedVersion;
    }

    if (_appiumSupport.util.compareVersions(this.opts.platformVersion, '<', '9.3')) {
      throw new Error(`Platform version must be 9.3 or above. '${this.opts.platformVersion}' is not supported.`);
    }

    if (_lodash.default.isEmpty(this.xcodeVersion) && (!this.opts.webDriverAgentUrl || !this.opts.realDevice)) {
      this.xcodeVersion = await (0, _utils.getAndCheckXcodeVersion)();
    }

    this.logEvent('xcodeDetailsRetrieved');

    if (this.opts.enableAsyncExecuteFromHttps && !this.isRealDevice()) {
      await (0, _simulatorManagement.shutdownSimulator)(this.opts.device);
      await this.startHttpsAsyncServer();
    }

    if (!this.opts.platformVersion) {
      if (this.opts.device && _lodash.default.isFunction(this.opts.device.getPlatformVersion)) {
        this.opts.platformVersion = await this.opts.device.getPlatformVersion();

        _logger.default.info(`No platformVersion specified. Using device version: '${this.opts.platformVersion}'`);
      } else {}
    }

    if ((this.opts.browserName || '').toLowerCase() === 'safari') {
      _logger.default.info('Safari test requested');

      this.safari = true;
      this.opts.app = undefined;
      this.opts.processArguments = this.opts.processArguments || {};
      this.opts.bundleId = SAFARI_BUNDLE_ID;
      this._currentUrl = this.opts.safariInitialUrl || (this.isRealDevice() ? 'http://appium.io' : `http://${this.opts.address}:${this.opts.port}/welcome`);

      if (_appiumSupport.util.compareVersions(this.opts.platformVersion, '<', '12.2')) {
        this.opts.processArguments.args = ['-u', this._currentUrl];
      }
    } else {
      await this.configureApp();
    }

    this.logEvent('appConfigured');

    if (this.opts.app) {
      await (0, _utils.checkAppPresent)(this.opts.app);
    }

    if (!this.opts.bundleId) {
      this.opts.bundleId = await _appiumIosDriver.appUtils.extractBundleId(this.opts.app);
    }

    await this.runReset();

    const memoizedLogInfo = _lodash.default.memoize(function logInfo() {
      _logger.default.info("'skipLogCapture' is set. Skipping starting logs such as crash, system, safari console and safari network.");
    });

    const startLogCapture = async () => {
      if (this.opts.skipLogCapture) {
        memoizedLogInfo();
        return false;
      }

      const result = await this.startLogCapture();

      if (result) {
        this.logEvent('logCaptureStarted');
      }

      return result;
    };

    const isLogCaptureStarted = await startLogCapture();

    _logger.default.info(`Setting up ${this.isRealDevice() ? 'real device' : 'simulator'}`);

    if (this.isSimulator()) {
      if (this.opts.shutdownOtherSimulators) {
        this.ensureFeatureEnabled(SHUTDOWN_OTHER_FEAT_NAME);
        await (0, _simulatorManagement.shutdownOtherSimulators)(this.opts.device);
      }

      if (this.isSafari() && this.opts.safariGlobalPreferences) {
        if (await this.opts.device.updateSafariGlobalSettings(this.opts.safariGlobalPreferences)) {
          _logger.default.debug(`Safari global preferences updated`);
        }
      }

      this.localConfig = await _appiumIosDriver.settings.setLocaleAndPreferences(this.opts.device, this.opts, this.isSafari(), async sim => {
        await (0, _simulatorManagement.shutdownSimulator)(sim);
        await _appiumIosDriver.settings.setLocaleAndPreferences(sim, this.opts, this.isSafari());
      });
      await this.startSim();

      if (this.opts.customSSLCert) {
        if (await (0, _appiumIosSimulator.hasSSLCert)(this.opts.customSSLCert, this.opts.udid)) {
          _logger.default.info(`SSL cert '${_lodash.default.truncate(this.opts.customSSLCert, {
            length: 20
          })}' already installed`);
        } else {
          _logger.default.info(`Installing ssl cert '${_lodash.default.truncate(this.opts.customSSLCert, {
            length: 20
          })}'`);

          await (0, _simulatorManagement.shutdownSimulator)(this.opts.device);
          await (0, _appiumIosSimulator.installSSLCert)(this.opts.customSSLCert, this.opts.udid);

          _logger.default.info(`Restarting Simulator so that SSL certificate installation takes effect`);

          await this.startSim();
          this.logEvent('customCertInstalled');
        }
      }

      try {
        const idb = new _appiumIdb.default({
          udid
        });
        await idb.connect();
        this.opts.device.idb = idb;
      } catch (e) {
        _logger.default.info(`idb will not be used for Simulator interaction. Original error: ${e.message}`);
      }

      this.logEvent('simStarted');

      if (!isLogCaptureStarted) {
        await startLogCapture();
      }
    }

    if (this.opts.app) {
      await this.installAUT();
      this.logEvent('appInstalled');
    }

    if (!this.opts.app && this.opts.bundleId && !this.safari) {
      if (!(await this.opts.device.isAppInstalled(this.opts.bundleId))) {
        _logger.default.errorAndThrow(`App with bundle identifier '${this.opts.bundleId}' unknown`);
      }
    }

    if (this.opts.permissions) {
      if (this.isSimulator()) {
        _logger.default.debug('Setting the requested permissions before WDA is started');

        for (const [bundleId, permissionsMapping] of _lodash.default.toPairs(JSON.parse(this.opts.permissions))) {
          await this.opts.device.setPermissions(bundleId, permissionsMapping);
        }
      } else {
        _logger.default.warn('Setting permissions is only supported on Simulator. ' + 'The "permissions" capability will be ignored.');
      }
    }

    await this.startWda(this.opts.sessionId, realDevice);
    await this.setReduceMotion(this.opts.reduceMotion);
    await this.setInitialOrientation(this.opts.orientation);
    this.logEvent('orientationSet');

    if (this.isSafari() && !this.isRealDevice() && _appiumSupport.util.compareVersions(this.opts.platformVersion, '>=', '12.2')) {
      await (0, _nodeSimctl.openUrl)(this.opts.device.udid, this._currentUrl);
    }

    if (this.isSafari() || this.opts.autoWebview) {
      _logger.default.debug('Waiting for initial webview');

      await this.navToInitialWebview();
      this.logEvent('initialWebviewNavigated');
    }

    if (this.isSafari() && this.isRealDevice() && _appiumSupport.util.compareVersions(this.opts.platformVersion, '>=', '12.2')) {
      await this.setUrl(this._currentUrl);
    }

    if (!this.isRealDevice()) {
      if (this.opts.calendarAccessAuthorized) {
        await this.opts.device.enableCalendarAccess(this.opts.bundleId);
      } else if (this.opts.calendarAccessAuthorized === false) {
        await this.opts.device.disableCalendarAccess(this.opts.bundleId);
      }
    }
  }

  async startWda(sessionId, realDevice) {
    this.wda = new _webdriveragent.default(this.xcodeVersion, this.opts);

    if (!_appiumSupport.util.hasValue(this.wda.webDriverAgentUrl)) {
      await this.wda.cleanupObsoleteProcesses();
    }

    const usePortForwarding = this.isRealDevice() && !this.wda.webDriverAgentUrl && (0, _utils.isLocalHost)(this.wda.wdaBaseUrl);
    await _deviceConnectionsFactory.default.requestConnection(this.opts.udid, this.wda.url.port, {
      devicePort: this.wda.wdaRemotePort,
      usePortForwarding
    });
    let synchronizationKey = XCUITestDriver.name;

    if (this.opts.useXctestrunFile || !(await this.wda.isSourceFresh())) {
      const derivedDataPath = await this.wda.retrieveDerivedDataPath();

      if (derivedDataPath) {
        synchronizationKey = _path.default.normalize(derivedDataPath);
      }
    }

    _logger.default.debug(`Starting WebDriverAgent initialization with the synchronization key '${synchronizationKey}'`);

    if (SHARED_RESOURCES_GUARD.isBusy() && !this.opts.derivedDataPath && !this.opts.bootstrapPath) {
      _logger.default.debug(`Consider setting a unique 'derivedDataPath' capability value for each parallel driver instance ` + `to avoid conflicts and speed up the building process`);
    }

    return await SHARED_RESOURCES_GUARD.acquire(synchronizationKey, async () => {
      if (this.opts.useNewWDA) {
        _logger.default.debug(`Capability 'useNewWDA' set to true, so uninstalling WDA before proceeding`);

        await this.wda.quitAndUninstall();
        this.logEvent('wdaUninstalled');
      } else if (!_appiumSupport.util.hasValue(this.wda.webDriverAgentUrl)) {
        await this.wda.setupCaching();
      }

      const quitAndUninstall = async msg => {
        _logger.default.debug(msg);

        if (this.opts.webDriverAgentUrl) {
          _logger.default.debug('Not quitting/uninstalling WebDriverAgent since webDriverAgentUrl capability is provided');

          throw new Error(msg);
        }

        _logger.default.warn('Quitting and uninstalling WebDriverAgent');

        await this.wda.quitAndUninstall();
        throw new Error(msg);
      };

      const startupRetries = this.opts.wdaStartupRetries || (this.isRealDevice() ? WDA_REAL_DEV_STARTUP_RETRIES : WDA_SIM_STARTUP_RETRIES);
      const startupRetryInterval = this.opts.wdaStartupRetryInterval || WDA_STARTUP_RETRY_INTERVAL;

      _logger.default.debug(`Trying to start WebDriverAgent ${startupRetries} times with ${startupRetryInterval}ms interval`);

      if (!_appiumSupport.util.hasValue(this.opts.wdaStartupRetries) && !_appiumSupport.util.hasValue(this.opts.wdaStartupRetryInterval)) {
        _logger.default.debug(`These values can be customized by changing wdaStartupRetries/wdaStartupRetryInterval capabilities`);
      }

      let retryCount = 0;
      await (0, _asyncbox.retryInterval)(startupRetries, startupRetryInterval, async () => {
        this.logEvent('wdaStartAttempted');

        if (retryCount > 0) {
          _logger.default.info(`Retrying WDA startup (${retryCount + 1} of ${startupRetries})`);
        }

        try {
          const retries = this.xcodeVersion.major >= 10 ? 2 : 1;
          this.cachedWdaStatus = await (0, _asyncbox.retry)(retries, this.wda.launch.bind(this.wda), sessionId, realDevice);
        } catch (err) {
          this.logEvent('wdaStartFailed');
          retryCount++;
          let errorMsg = `Unable to launch WebDriverAgent because of xcodebuild failure: ${err.message}`;

          if (this.isRealDevice()) {
            errorMsg += `. Make sure you follow the tutorial at ${WDA_REAL_DEV_TUTORIAL_URL}. ` + `Try to remove the WebDriverAgentRunner application from the device if it is installed ` + `and reboot the device.`;
          }

          await quitAndUninstall(errorMsg);
        }

        this.proxyReqRes = this.wda.proxyReqRes.bind(this.wda);
        this.jwpProxyActive = true;
        let originalStacktrace = null;

        try {
          await (0, _asyncbox.retryInterval)(15, 1000, async () => {
            this.logEvent('wdaSessionAttempted');

            _logger.default.debug('Sending createSession command to WDA');

            try {
              this.cachedWdaStatus = this.cachedWdaStatus || (await this.proxyCommand('/status', 'GET'));
              await this.startWdaSession(this.opts.bundleId, this.opts.processArguments);
            } catch (err) {
              originalStacktrace = err.stack;

              _logger.default.debug(`Failed to create WDA session (${err.message}). Retrying...`);

              throw err;
            }
          });
          this.logEvent('wdaSessionStarted');
        } catch (err) {
          if (originalStacktrace) {
            _logger.default.debug(originalStacktrace);
          }

          let errorMsg = `Unable to start WebDriverAgent session because of xcodebuild failure: ${err.message}`;

          if (this.isRealDevice()) {
            errorMsg += ` Make sure you follow the tutorial at ${WDA_REAL_DEV_TUTORIAL_URL}. ` + `Try to remove the WebDriverAgentRunner application from the device if it is installed ` + `and reboot the device.`;
          }

          await quitAndUninstall(errorMsg);
        }

        if (this.opts.clearSystemFiles && !this.opts.webDriverAgentUrl) {
          await (0, _utils.markSystemFilesForCleanup)(this.wda);
        }

        this.wda.fullyStarted = true;
        this.logEvent('wdaStarted');
      });
    });
  }

  async runReset(opts = null) {
    this.logEvent('resetStarted');

    if (this.isRealDevice()) {
      await (0, _realDeviceManagement.runRealDeviceReset)(this.opts.device, opts || this.opts);
    } else {
      await (0, _simulatorManagement.runSimulatorReset)(this.opts.device, opts || this.opts);
    }

    this.logEvent('resetComplete');
  }

  async deleteSession() {
    await (0, _utils.removeAllSessionWebSocketHandlers)(this.server, this.sessionId);

    if (this.isSimulator() && (this.opts.device || {}).idb) {
      await this.opts.device.idb.disconnect();
      this.opts.device.idb = null;
    }

    await this.stop();

    if (this.opts.clearSystemFiles && this.isAppTemporary) {
      await _appiumSupport.fs.rimraf(this.opts.app);
    }

    if (this.wda && !this.opts.webDriverAgentUrl) {
      if (this.opts.clearSystemFiles) {
        let synchronizationKey = XCUITestDriver.name;
        const derivedDataPath = await this.wda.retrieveDerivedDataPath();

        if (derivedDataPath) {
          synchronizationKey = _path.default.normalize(derivedDataPath);
        }

        await SHARED_RESOURCES_GUARD.acquire(synchronizationKey, async () => {
          await (0, _utils.clearSystemFiles)(this.wda);
        });
      } else {
        _logger.default.debug('Not clearing log files. Use `clearSystemFiles` capability to turn on.');
      }
    }

    if (this.isWebContext()) {
      _logger.default.debug('In a web session. Removing remote debugger');

      await this.stopRemote();
    }

    if (this.opts.resetOnSessionStartOnly === false) {
      await this.runReset(Object.assign({}, this.opts, {
        enforceSimulatorShutdown: true
      }));
    }

    if (this.isSimulator() && !this.opts.noReset && !!this.opts.device) {
      if (this.lifecycleData.createSim) {
        _logger.default.debug(`Deleting simulator created for this run (udid: '${this.opts.udid}')`);

        await (0, _simulatorManagement.shutdownSimulator)(this.opts.device);
        await this.opts.device.delete();
      }
    }

    if (!_lodash.default.isEmpty(this.logs)) {
      await this.logs.syslog.stopCapture();
      this.logs = {};
    }

    if (this.opts.enableAsyncExecuteFromHttps && !this.isRealDevice()) {
      await this.stopHttpsAsyncServer();
    }

    if (this.mjpegStream) {
      _logger.default.info('Closing MJPEG stream');

      this.mjpegStream.stop();
    }

    this.resetIos();
    await super.deleteSession();
  }

  async stop() {
    this.jwpProxyActive = false;
    this.proxyReqRes = null;

    if (this.wda && this.wda.fullyStarted) {
      if (this.wda.jwproxy) {
        try {
          await this.proxyCommand(`/session/${this.sessionId}`, 'DELETE');
        } catch (err) {
          _logger.default.debug(`Unable to DELETE session on WDA: '${err.message}'. Continuing shutdown.`);
        }
      }

      if (!this.wda.webDriverAgentUrl && this.opts.useNewWDA) {
        await this.wda.quit();
      }
    }

    _deviceConnectionsFactory.default.releaseConnection(this.opts.udid);
  }

  async executeCommand(cmd, ...args) {
    _logger.default.debug(`Executing command '${cmd}'`);

    if (cmd === 'receiveAsyncResponse') {
      return await this.receiveAsyncResponse(...args);
    }

    if (cmd === 'getStatus') {
      return await this.getStatus();
    }

    return await super.executeCommand(cmd, ...args);
  }

  async configureApp() {
    function appIsPackageOrBundle(app) {
      return /^([a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+)+$/.test(app);
    }

    if (!this.opts.bundleId && appIsPackageOrBundle(this.opts.app)) {
      this.opts.bundleId = this.opts.app;
      this.opts.app = '';
    }

    if (this.opts.bundleId && appIsPackageOrBundle(this.opts.bundleId) && (this.opts.app === '' || appIsPackageOrBundle(this.opts.app))) {
      _logger.default.debug('App is an iOS bundle, will attempt to run as pre-existing');

      return;
    }

    if (this.opts.app && this.opts.app.toLowerCase() === 'settings') {
      this.opts.bundleId = 'com.apple.Preferences';
      this.opts.app = null;
      return;
    } else if (this.opts.app && this.opts.app.toLowerCase() === 'calendar') {
      this.opts.bundleId = 'com.apple.mobilecal';
      this.opts.app = null;
      return;
    }

    const originalAppPath = this.opts.app;

    try {
      this.opts.app = await this.helpers.configureApp(this.opts.app, '.app');
    } catch (err) {
      _logger.default.error(err);

      throw new Error(`Bad app: ${this.opts.app}. App paths need to be absolute or an URL to a compressed app file${err && err.message ? `: ${err.message}` : ''}`);
    }

    this.isAppTemporary = this.opts.app && (await _appiumSupport.fs.exists(this.opts.app)) && !(await _appiumSupport.util.isSameDestination(originalAppPath, this.opts.app));
  }

  async determineDevice() {
    this.lifecycleData.createSim = false;
    this.opts.deviceName = (0, _utils.translateDeviceName)(this.opts.platformVersion, this.opts.deviceName);

    const setupVersionCaps = async () => {
      this.opts.iosSdkVersion = await (0, _utils.getAndCheckIosSdkVersion)();

      _logger.default.info(`iOS SDK Version set to '${this.opts.iosSdkVersion}'`);

      if (!this.opts.platformVersion && this.opts.iosSdkVersion) {
        _logger.default.info(`No platformVersion specified. Using the latest version Xcode supports: '${this.opts.iosSdkVersion}'. ` + `This may cause problems if a simulator does not exist for this platform version.`);

        this.opts.platformVersion = (0, _utils.normalizePlatformVersion)(this.opts.iosSdkVersion);
      }
    };

    if (this.opts.udid) {
      if (this.opts.udid.toLowerCase() === 'auto') {
        try {
          this.opts.udid = await (0, _utils.detectUdid)();
        } catch (err) {
          _logger.default.warn(`Cannot detect any connected real devices. Falling back to Simulator. Original error: ${err.message}`);

          const device = await (0, _simulatorManagement.getExistingSim)(this.opts);

          if (!device) {
            _logger.default.errorAndThrow(`Cannot detect udid for ${this.opts.deviceName} Simulator running iOS ${this.opts.platformVersion}`);
          }

          this.opts.udid = device.udid;
          const devicePlatform = (0, _utils.normalizePlatformVersion)((await device.getPlatformVersion()));

          if (this.opts.platformVersion !== devicePlatform) {
            this.opts.platformVersion = devicePlatform;

            _logger.default.info(`Set platformVersion to '${devicePlatform}' to match the device with given UDID`);
          }

          await setupVersionCaps();
          return {
            device,
            realDevice: false,
            udid: device.udid
          };
        }
      } else {
        const devices = await (0, _realDeviceManagement.getConnectedDevices)();

        _logger.default.debug(`Available devices: ${devices.join(', ')}`);

        if (!devices.includes(this.opts.udid)) {
          if (await (0, _appiumIosSimulator.simExists)(this.opts.udid)) {
            const device = await (0, _appiumIosSimulator.getSimulator)(this.opts.udid);
            return {
              device,
              realDevice: false,
              udid: this.opts.udid
            };
          }

          throw new Error(`Unknown device or simulator UDID: '${this.opts.udid}'`);
        }
      }

      const device = await (0, _realDeviceManagement.getRealDeviceObj)(this.opts.udid);

      if (_lodash.default.isEmpty(this.opts.platformVersion)) {
        _logger.default.info('Getting the platformVersion from the phone since it was not specified in the capabilities');

        try {
          const osVersion = await (0, _realDeviceManagement.getOSVersion)(this.opts.udid);
          this.opts.platformVersion = _appiumSupport.util.coerceVersion(osVersion);
        } catch (e) {
          _logger.default.warn(`Cannot determine real device platform version. Original error: ${e.message}`);
        }
      }

      return {
        device,
        realDevice: true,
        udid: this.opts.udid
      };
    }

    await setupVersionCaps();

    if (this.opts.enforceFreshSimulatorCreation) {
      _logger.default.debug(`New simulator is requested. If this is not wanted, set 'enforceFreshSimulatorCreation' capability to false`);
    } else {
      const device = await (0, _simulatorManagement.getExistingSim)(this.opts);

      if (device) {
        return {
          device,
          realDevice: false,
          udid: device.udid
        };
      }

      _logger.default.info('Simulator udid not provided');
    }

    _logger.default.info('Using desired caps to create a new simulator');

    const device = await this.createSim();
    return {
      device,
      realDevice: false,
      udid: device.udid
    };
  }

  async startSim() {
    const runOpts = {
      scaleFactor: this.opts.scaleFactor,
      connectHardwareKeyboard: !!this.opts.connectHardwareKeyboard,
      isHeadless: !!this.opts.isHeadless,
      devicePreferences: {}
    };

    if (this.opts.SimulatorWindowCenter) {
      runOpts.devicePreferences.SimulatorWindowCenter = this.opts.SimulatorWindowCenter;
    }

    const orientation = _lodash.default.isString(this.opts.orientation) && this.opts.orientation.toUpperCase();

    switch (orientation) {
      case 'LANDSCAPE':
        runOpts.devicePreferences.SimulatorWindowOrientation = 'LandscapeLeft';
        runOpts.devicePreferences.SimulatorWindowRotationAngle = 90;
        break;

      case 'PORTRAIT':
        runOpts.devicePreferences.SimulatorWindowOrientation = 'Portrait';
        runOpts.devicePreferences.SimulatorWindowRotationAngle = 0;
        break;
    }

    await this.opts.device.run(runOpts);
  }

  async createSim() {
    this.lifecycleData.createSim = true;
    const platformName = (0, _utils.isTvOS)(this.opts.platformName) ? _desiredCaps.PLATFORM_NAME_TVOS : _desiredCaps.PLATFORM_NAME_IOS;
    let sim = await (0, _simulatorManagement.createSim)(this.opts, platformName);

    _logger.default.info(`Created simulator with udid '${sim.udid}'.`);

    return sim;
  }

  async launchApp() {
    const APP_LAUNCH_TIMEOUT = 20 * 1000;
    this.logEvent('appLaunchAttempted');
    await (0, _nodeSimctl.launch)(this.opts.device.udid, this.opts.bundleId);

    let checkStatus = async () => {
      let response = await this.proxyCommand('/status', 'GET');
      let currentApp = response.currentApp.bundleID;

      if (currentApp !== this.opts.bundleId) {
        throw new Error(`${this.opts.bundleId} not in foreground. ${currentApp} is in foreground`);
      }
    };

    _logger.default.info(`Waiting for '${this.opts.bundleId}' to be in foreground`);

    let retries = parseInt(APP_LAUNCH_TIMEOUT / 200, 10);
    await (0, _asyncbox.retryInterval)(retries, 200, checkStatus);

    _logger.default.info(`${this.opts.bundleId} is in foreground`);

    this.logEvent('appLaunched');
  }

  async startWdaSession(bundleId, processArguments) {
    let args = processArguments ? processArguments.args || [] : [];

    if (!_lodash.default.isArray(args)) {
      throw new Error(`processArguments.args capability is expected to be an array. ` + `${JSON.stringify(args)} is given instead`);
    }

    let env = processArguments ? processArguments.env || {} : {};

    if (!_lodash.default.isPlainObject(env)) {
      throw new Error(`processArguments.env capability is expected to be a dictionary. ` + `${JSON.stringify(env)} is given instead`);
    }

    let shouldWaitForQuiescence = _appiumSupport.util.hasValue(this.opts.waitForQuiescence) ? this.opts.waitForQuiescence : true;
    let maxTypingFrequency = _appiumSupport.util.hasValue(this.opts.maxTypingFrequency) ? this.opts.maxTypingFrequency : 60;
    let shouldUseSingletonTestManager = _appiumSupport.util.hasValue(this.opts.shouldUseSingletonTestManager) ? this.opts.shouldUseSingletonTestManager : true;
    let shouldUseTestManagerForVisibilityDetection = false;
    let eventloopIdleDelaySec = this.opts.wdaEventloopIdleDelay || 0;

    if (_appiumSupport.util.hasValue(this.opts.simpleIsVisibleCheck)) {
      shouldUseTestManagerForVisibilityDetection = this.opts.simpleIsVisibleCheck;
    }

    if (_appiumSupport.util.compareVersions(this.opts.platformVersion, '==', '9.3')) {
      _logger.default.info(`Forcing shouldUseSingletonTestManager capability value to true, because of known XCTest issues under 9.3 platform version`);

      shouldUseTestManagerForVisibilityDetection = true;
    }

    if (_appiumSupport.util.hasValue(this.opts.language)) {
      args.push('-AppleLanguages', `(${this.opts.language})`);
      args.push('-NSLanguages', `(${this.opts.language})`);
    }

    if (_appiumSupport.util.hasValue(this.opts.locale)) {
      args.push('-AppleLocale', this.opts.locale);
    }

    const wdaCaps = {
      bundleId: this.opts.autoLaunch === false ? undefined : bundleId,
      arguments: args,
      environment: env,
      eventloopIdleDelaySec,
      shouldWaitForQuiescence,
      shouldUseTestManagerForVisibilityDetection,
      maxTypingFrequency,
      shouldUseSingletonTestManager
    };

    if (_appiumSupport.util.hasValue(this.opts.shouldUseCompactResponses)) {
      wdaCaps.shouldUseCompactResponses = this.opts.shouldUseCompactResponses;
    }

    if (_appiumSupport.util.hasValue(this.opts.elementResponseFields)) {
      wdaCaps.elementResponseFields = this.opts.elementResponseFields;
    }

    if (this.opts.autoAcceptAlerts) {
      wdaCaps.defaultAlertAction = 'accept';
    } else if (this.opts.autoDismissAlerts) {
      wdaCaps.defaultAlertAction = 'dismiss';
    }

    await this.proxyCommand('/session', 'POST', {
      capabilities: {
        firstMatch: [wdaCaps],
        alwaysMatch: {}
      }
    });
  }

  proxyActive() {
    return this.jwpProxyActive;
  }

  getProxyAvoidList() {
    if (this.isWebview()) {
      return NO_PROXY_WEB_LIST;
    }

    return NO_PROXY_NATIVE_LIST;
  }

  canProxy() {
    return true;
  }

  isSafari() {
    return !!this.safari;
  }

  isRealDevice() {
    return this.opts.realDevice;
  }

  isSimulator() {
    return !this.opts.realDevice;
  }

  isWebview() {
    return this.isSafari() || this.isWebContext();
  }

  validateLocatorStrategy(strategy) {
    super.validateLocatorStrategy(strategy, this.isWebContext());
  }

  validateDesiredCaps(caps) {
    if (!super.validateDesiredCaps(caps)) {
      return false;
    }

    if ((caps.browserName || '').toLowerCase() !== 'safari' && !caps.app && !caps.bundleId) {
      let msg = 'The desired capabilities must include either an app or a bundleId for iOS';

      _logger.default.errorAndThrow(msg);
    }

    if (!_appiumSupport.util.coerceVersion(caps.platformVersion, false)) {
      _logger.default.warn(`'platformVersion' capability ('${caps.platformVersion}') is not a valid version number. ` + `Consider fixing it or be ready to experience an inconsistent driver behavior.`);
    }

    let verifyProcessArgument = processArguments => {
      const {
        args,
        env
      } = processArguments;

      if (!_lodash.default.isNil(args) && !_lodash.default.isArray(args)) {
        _logger.default.errorAndThrow('processArguments.args must be an array of strings');
      }

      if (!_lodash.default.isNil(env) && !_lodash.default.isPlainObject(env)) {
        _logger.default.errorAndThrow('processArguments.env must be an object <key,value> pair {a:b, c:d}');
      }
    };

    if (caps.processArguments) {
      if (_lodash.default.isString(caps.processArguments)) {
        try {
          caps.processArguments = JSON.parse(caps.processArguments);
          verifyProcessArgument(caps.processArguments);
        } catch (err) {
          _logger.default.errorAndThrow(`processArguments must be a json format or an object with format {args : [], env : {a:b, c:d}}. ` + `Both environment and argument can be null. Error: ${err}`);
        }
      } else if (_lodash.default.isPlainObject(caps.processArguments)) {
        verifyProcessArgument(caps.processArguments);
      } else {
        _logger.default.errorAndThrow(`'processArguments must be an object, or a string JSON object with format {args : [], env : {a:b, c:d}}. ` + `Both environment and argument can be null.`);
      }
    }

    if (caps.keychainPath && !caps.keychainPassword || !caps.keychainPath && caps.keychainPassword) {
      _logger.default.errorAndThrow(`If 'keychainPath' is set, 'keychainPassword' must also be set (and vice versa).`);
    }

    this.opts.resetOnSessionStartOnly = !_appiumSupport.util.hasValue(this.opts.resetOnSessionStartOnly) || this.opts.resetOnSessionStartOnly;
    this.opts.useNewWDA = _appiumSupport.util.hasValue(this.opts.useNewWDA) ? this.opts.useNewWDA : false;

    if (caps.commandTimeouts) {
      caps.commandTimeouts = (0, _utils.normalizeCommandTimeouts)(caps.commandTimeouts);
    }

    if (_lodash.default.isString(caps.webDriverAgentUrl)) {
      const {
        protocol,
        host
      } = _url.default.parse(caps.webDriverAgentUrl);

      if (_lodash.default.isEmpty(protocol) || _lodash.default.isEmpty(host)) {
        _logger.default.errorAndThrow(`'webDriverAgentUrl' capability is expected to contain a valid WebDriverAgent server URL. ` + `'${caps.webDriverAgentUrl}' is given instead`);
      }
    }

    if (caps.browserName) {
      if (caps.bundleId) {
        _logger.default.errorAndThrow(`'browserName' cannot be set together with 'bundleId' capability`);
      }

      if (caps.app) {
        _logger.default.warn(`The capabilities should generally not include both an 'app' and a 'browserName'`);
      }
    }

    if (caps.permissions) {
      try {
        for (const [bundleId, perms] of _lodash.default.toPairs(JSON.parse(caps.permissions))) {
          if (!_lodash.default.isString(bundleId)) {
            throw new Error(`'${JSON.stringify(bundleId)}' must be a string`);
          }

          if (!_lodash.default.isPlainObject(perms)) {
            throw new Error(`'${JSON.stringify(perms)}' must be a JSON object`);
          }
        }
      } catch (e) {
        _logger.default.errorAndThrow(`'${caps.permissions}' is expected to be a valid object with format ` + `{"<bundleId1>": {"<serviceName1>": "<serviceStatus1>", ...}, ...}. Original error: ${e.message}`);
      }
    }

    if (caps.platformVersion && !_appiumSupport.util.coerceVersion(caps.platformVersion, false)) {
      _logger.default.errorAndThrow(`'platformVersion' must be a valid version number. ` + `'${caps.platformVersion}' is given instead.`);
    }

    return true;
  }

  async installAUT() {
    if (this.isSafari()) {
      return;
    }

    try {
      await (0, _utils.verifyApplicationPlatform)(this.opts.app, this.isSimulator(), (0, _utils.isTvOS)(this.opts.platformName));
    } catch (err) {
      _logger.default.warn(`*********************************`);

      _logger.default.warn(`${this.isSimulator() ? 'Simulator' : 'Real device'} architecture appears to be unsupported ` + `by the '${this.opts.app}' application. ` + `Make sure the correct deployment target has been selected for its compilation in Xcode.`);

      _logger.default.warn('Don\'t be surprised if the application fails to launch.');

      _logger.default.warn(`*********************************`);
    }

    if (this.isRealDevice()) {
      await (0, _realDeviceManagement.installToRealDevice)(this.opts.device, this.opts.app, this.opts.bundleId, this.opts.noReset);
    } else {
      await (0, _simulatorManagement.installToSimulator)(this.opts.device, this.opts.app, this.opts.bundleId, this.opts.noReset);
    }

    if (this.opts.otherApps) {
      await this.installOtherApps(this.opts.otherApps);
    }

    if (_appiumSupport.util.hasValue(this.opts.iosInstallPause)) {
      let pause = parseInt(this.opts.iosInstallPause, 10);

      _logger.default.debug(`iosInstallPause set. Pausing ${pause} ms before continuing`);

      await _bluebird.default.delay(pause);
    }
  }

  async installOtherApps(otherApps) {
    if (this.isRealDevice()) {
      _logger.default.warn('Capability otherApps is only supported for Simulators');

      return;
    }

    try {
      otherApps = this.helpers.parseCapsArray(otherApps);
    } catch (e) {
      _logger.default.errorAndThrow(`Could not parse "otherApps" capability: ${e.message}`);
    }

    for (const otherApp of otherApps) {
      await (0, _simulatorManagement.installToSimulator)(this.opts.device, otherApp, undefined, this.opts.noReset);
    }
  }

  async setReduceMotion(isEnabled) {
    if (this.isRealDevice() || !_lodash.default.isBoolean(isEnabled)) {
      return;
    }

    _logger.default.info(`Setting reduceMotion to ${isEnabled}`);

    await this.updateSettings({
      reduceMotion: isEnabled
    });
  }

  async setInitialOrientation(orientation) {
    if (!_lodash.default.isString(orientation)) {
      _logger.default.info('Skipping setting of the initial display orientation. ' + 'Set the "orientation" capability to either "LANDSCAPE" or "PORTRAIT", if this is an undesired behavior.');

      return;
    }

    orientation = orientation.toUpperCase();

    if (!_lodash.default.includes(['LANDSCAPE', 'PORTRAIT'], orientation)) {
      _logger.default.debug(`Unable to set initial orientation to '${orientation}'`);

      return;
    }

    _logger.default.debug(`Setting initial orientation to '${orientation}'`);

    try {
      await this.proxyCommand('/orientation', 'POST', {
        orientation
      });
      this.opts.curOrientation = orientation;
    } catch (err) {
      _logger.default.warn(`Setting initial orientation failed with: ${err.message}`);
    }
  }

  _getCommandTimeout(cmdName) {
    if (this.opts.commandTimeouts) {
      if (cmdName && _lodash.default.has(this.opts.commandTimeouts, cmdName)) {
        return this.opts.commandTimeouts[cmdName];
      }

      return this.opts.commandTimeouts[_utils.DEFAULT_TIMEOUT_KEY];
    }
  }

  async getSession() {
    const driverSession = await super.getSession();

    if (!this.wdaCaps) {
      this.wdaCaps = await this.proxyCommand('/', 'GET');
    }

    if (!this.deviceCaps) {
      const {
        statusBarSize,
        scale
      } = await this.getScreenInfo();
      this.deviceCaps = {
        pixelRatio: scale,
        statBarHeight: statusBarSize.height,
        viewportRect: await this.getViewportRect()
      };
    }

    _logger.default.info('Merging WDA caps over Appium caps for session detail response');

    return Object.assign({
      udid: this.opts.udid
    }, driverSession, this.wdaCaps.capabilities, this.deviceCaps);
  }

  async reset() {
    if (this.opts.noReset) {
      let opts = _lodash.default.cloneDeep(this.opts);

      opts.noReset = false;
      opts.fullReset = false;
      const shutdownHandler = this.resetOnUnexpectedShutdown;

      this.resetOnUnexpectedShutdown = () => {};

      try {
        await this.runReset(opts);
      } finally {
        this.resetOnUnexpectedShutdown = shutdownHandler;
      }
    }

    await super.reset();
  }

}

exports.XCUITestDriver = XCUITestDriver;
Object.assign(XCUITestDriver.prototype, _index.default);
var _default = XCUITestDriver;
exports.default = _default;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImxpYi9kcml2ZXIuanMiXSwibmFtZXMiOlsiU0hVVERPV05fT1RIRVJfRkVBVF9OQU1FIiwiU0FGQVJJX0JVTkRMRV9JRCIsIldEQV9TSU1fU1RBUlRVUF9SRVRSSUVTIiwiV0RBX1JFQUxfREVWX1NUQVJUVVBfUkVUUklFUyIsIldEQV9SRUFMX0RFVl9UVVRPUklBTF9VUkwiLCJXREFfU1RBUlRVUF9SRVRSWV9JTlRFUlZBTCIsIkRFRkFVTFRfU0VUVElOR1MiLCJuYXRpdmVXZWJUYXAiLCJ1c2VKU09OU291cmNlIiwic2hvdWxkVXNlQ29tcGFjdFJlc3BvbnNlcyIsImVsZW1lbnRSZXNwb25zZUF0dHJpYnV0ZXMiLCJtanBlZ1NlcnZlclNjcmVlbnNob3RRdWFsaXR5IiwibWpwZWdTZXJ2ZXJGcmFtZXJhdGUiLCJzY3JlZW5zaG90UXVhbGl0eSIsIm1qcGVnU2NhbGluZ0ZhY3RvciIsInJlZHVjZU1vdGlvbiIsIlNIQVJFRF9SRVNPVVJDRVNfR1VBUkQiLCJBc3luY0xvY2siLCJOT19QUk9YWV9OQVRJVkVfTElTVCIsIk5PX1BST1hZX1dFQl9MSVNUIiwiY29uY2F0IiwiTUVNT0laRURfRlVOQ1RJT05TIiwiWENVSVRlc3REcml2ZXIiLCJCYXNlRHJpdmVyIiwiY29uc3RydWN0b3IiLCJvcHRzIiwic2hvdWxkVmFsaWRhdGVDYXBzIiwiZGVzaXJlZENhcENvbnN0cmFpbnRzIiwibG9jYXRvclN0cmF0ZWdpZXMiLCJ3ZWJMb2NhdG9yU3RyYXRlZ2llcyIsInJlc2V0SW9zIiwic2V0dGluZ3MiLCJEZXZpY2VTZXR0aW5ncyIsIm9uU2V0dGluZ3NVcGRhdGUiLCJiaW5kIiwibG9ncyIsImZuIiwiXyIsIm1lbW9pemUiLCJrZXkiLCJ2YWx1ZSIsInByb3h5Q29tbWFuZCIsIndkYSIsImRldmljZSIsImp3cFByb3h5QWN0aXZlIiwicHJveHlSZXFSZXMiLCJqd3BQcm94eUF2b2lkIiwic2FmYXJpIiwiY2FjaGVkV2RhU3RhdHVzIiwiY3VyV2ViRnJhbWVzIiwid2ViRWxlbWVudElkcyIsIl9jdXJyZW50VXJsIiwiY3VyQ29udGV4dCIsInhjb2RlVmVyc2lvbiIsImNvbnRleHRzIiwiaW1wbGljaXRXYWl0TXMiLCJhc3luY2xpYldhaXRNcyIsInBhZ2VMb2FkTXMiLCJsYW5kc2NhcGVXZWJDb29yZHNPZmZzZXQiLCJkcml2ZXJEYXRhIiwiZ2V0U3RhdHVzIiwiZHJpdmVySW5mbyIsInN0YXR1cyIsImJ1aWxkIiwidmVyc2lvbiIsImNyZWF0ZVNlc3Npb24iLCJhcmdzIiwibGlmZWN5Y2xlRGF0YSIsInNlc3Npb25JZCIsImNhcHMiLCJzdGFydCIsIk9iamVjdCIsImFzc2lnbiIsImRlZmF1bHRTZXJ2ZXJDYXBzIiwidWRpZCIsImhhcyIsInVwZGF0ZVNldHRpbmdzIiwid2RhU2V0dGluZ3MiLCJsb2ciLCJpbmZvIiwibWpwZWdTY3JlZW5zaG90VXJsIiwibWpwZWdTdHJlYW0iLCJtanBlZyIsIk1KcGVnU3RyZWFtIiwiZSIsImVycm9yIiwiZGVsZXRlU2Vzc2lvbiIsIm5vUmVzZXQiLCJmdWxsUmVzZXQiLCJpb3NTZGtWZXJzaW9uIiwicmVhbERldmljZSIsImRldGVybWluZURldmljZSIsIm5vcm1hbGl6ZWRWZXJzaW9uIiwicGxhdGZvcm1WZXJzaW9uIiwidXRpbCIsImNvbXBhcmVWZXJzaW9ucyIsIkVycm9yIiwiaXNFbXB0eSIsIndlYkRyaXZlckFnZW50VXJsIiwibG9nRXZlbnQiLCJlbmFibGVBc3luY0V4ZWN1dGVGcm9tSHR0cHMiLCJpc1JlYWxEZXZpY2UiLCJzdGFydEh0dHBzQXN5bmNTZXJ2ZXIiLCJpc0Z1bmN0aW9uIiwiZ2V0UGxhdGZvcm1WZXJzaW9uIiwiYnJvd3Nlck5hbWUiLCJ0b0xvd2VyQ2FzZSIsImFwcCIsInVuZGVmaW5lZCIsInByb2Nlc3NBcmd1bWVudHMiLCJidW5kbGVJZCIsInNhZmFyaUluaXRpYWxVcmwiLCJhZGRyZXNzIiwicG9ydCIsImNvbmZpZ3VyZUFwcCIsImFwcFV0aWxzIiwiZXh0cmFjdEJ1bmRsZUlkIiwicnVuUmVzZXQiLCJtZW1vaXplZExvZ0luZm8iLCJsb2dJbmZvIiwic3RhcnRMb2dDYXB0dXJlIiwic2tpcExvZ0NhcHR1cmUiLCJyZXN1bHQiLCJpc0xvZ0NhcHR1cmVTdGFydGVkIiwiaXNTaW11bGF0b3IiLCJzaHV0ZG93bk90aGVyU2ltdWxhdG9ycyIsImVuc3VyZUZlYXR1cmVFbmFibGVkIiwiaXNTYWZhcmkiLCJzYWZhcmlHbG9iYWxQcmVmZXJlbmNlcyIsInVwZGF0ZVNhZmFyaUdsb2JhbFNldHRpbmdzIiwiZGVidWciLCJsb2NhbENvbmZpZyIsImlvc1NldHRpbmdzIiwic2V0TG9jYWxlQW5kUHJlZmVyZW5jZXMiLCJzaW0iLCJzdGFydFNpbSIsImN1c3RvbVNTTENlcnQiLCJ0cnVuY2F0ZSIsImxlbmd0aCIsImlkYiIsIklEQiIsImNvbm5lY3QiLCJtZXNzYWdlIiwiaW5zdGFsbEFVVCIsImlzQXBwSW5zdGFsbGVkIiwiZXJyb3JBbmRUaHJvdyIsInBlcm1pc3Npb25zIiwicGVybWlzc2lvbnNNYXBwaW5nIiwidG9QYWlycyIsIkpTT04iLCJwYXJzZSIsInNldFBlcm1pc3Npb25zIiwid2FybiIsInN0YXJ0V2RhIiwic2V0UmVkdWNlTW90aW9uIiwic2V0SW5pdGlhbE9yaWVudGF0aW9uIiwib3JpZW50YXRpb24iLCJhdXRvV2VidmlldyIsIm5hdlRvSW5pdGlhbFdlYnZpZXciLCJzZXRVcmwiLCJjYWxlbmRhckFjY2Vzc0F1dGhvcml6ZWQiLCJlbmFibGVDYWxlbmRhckFjY2VzcyIsImRpc2FibGVDYWxlbmRhckFjY2VzcyIsIldlYkRyaXZlckFnZW50IiwiaGFzVmFsdWUiLCJjbGVhbnVwT2Jzb2xldGVQcm9jZXNzZXMiLCJ1c2VQb3J0Rm9yd2FyZGluZyIsIndkYUJhc2VVcmwiLCJERVZJQ0VfQ09OTkVDVElPTlNfRkFDVE9SWSIsInJlcXVlc3RDb25uZWN0aW9uIiwidXJsIiwiZGV2aWNlUG9ydCIsIndkYVJlbW90ZVBvcnQiLCJzeW5jaHJvbml6YXRpb25LZXkiLCJuYW1lIiwidXNlWGN0ZXN0cnVuRmlsZSIsImlzU291cmNlRnJlc2giLCJkZXJpdmVkRGF0YVBhdGgiLCJyZXRyaWV2ZURlcml2ZWREYXRhUGF0aCIsInBhdGgiLCJub3JtYWxpemUiLCJpc0J1c3kiLCJib290c3RyYXBQYXRoIiwiYWNxdWlyZSIsInVzZU5ld1dEQSIsInF1aXRBbmRVbmluc3RhbGwiLCJzZXR1cENhY2hpbmciLCJtc2ciLCJzdGFydHVwUmV0cmllcyIsIndkYVN0YXJ0dXBSZXRyaWVzIiwic3RhcnR1cFJldHJ5SW50ZXJ2YWwiLCJ3ZGFTdGFydHVwUmV0cnlJbnRlcnZhbCIsInJldHJ5Q291bnQiLCJyZXRyaWVzIiwibWFqb3IiLCJsYXVuY2giLCJlcnIiLCJlcnJvck1zZyIsIm9yaWdpbmFsU3RhY2t0cmFjZSIsInN0YXJ0V2RhU2Vzc2lvbiIsInN0YWNrIiwiY2xlYXJTeXN0ZW1GaWxlcyIsImZ1bGx5U3RhcnRlZCIsInNlcnZlciIsImRpc2Nvbm5lY3QiLCJzdG9wIiwiaXNBcHBUZW1wb3JhcnkiLCJmcyIsInJpbXJhZiIsImlzV2ViQ29udGV4dCIsInN0b3BSZW1vdGUiLCJyZXNldE9uU2Vzc2lvblN0YXJ0T25seSIsImVuZm9yY2VTaW11bGF0b3JTaHV0ZG93biIsImNyZWF0ZVNpbSIsImRlbGV0ZSIsInN5c2xvZyIsInN0b3BDYXB0dXJlIiwic3RvcEh0dHBzQXN5bmNTZXJ2ZXIiLCJqd3Byb3h5IiwicXVpdCIsInJlbGVhc2VDb25uZWN0aW9uIiwiZXhlY3V0ZUNvbW1hbmQiLCJjbWQiLCJyZWNlaXZlQXN5bmNSZXNwb25zZSIsImFwcElzUGFja2FnZU9yQnVuZGxlIiwidGVzdCIsIm9yaWdpbmFsQXBwUGF0aCIsImhlbHBlcnMiLCJleGlzdHMiLCJpc1NhbWVEZXN0aW5hdGlvbiIsImRldmljZU5hbWUiLCJzZXR1cFZlcnNpb25DYXBzIiwiZGV2aWNlUGxhdGZvcm0iLCJkZXZpY2VzIiwiam9pbiIsImluY2x1ZGVzIiwib3NWZXJzaW9uIiwiY29lcmNlVmVyc2lvbiIsImVuZm9yY2VGcmVzaFNpbXVsYXRvckNyZWF0aW9uIiwicnVuT3B0cyIsInNjYWxlRmFjdG9yIiwiY29ubmVjdEhhcmR3YXJlS2V5Ym9hcmQiLCJpc0hlYWRsZXNzIiwiZGV2aWNlUHJlZmVyZW5jZXMiLCJTaW11bGF0b3JXaW5kb3dDZW50ZXIiLCJpc1N0cmluZyIsInRvVXBwZXJDYXNlIiwiU2ltdWxhdG9yV2luZG93T3JpZW50YXRpb24iLCJTaW11bGF0b3JXaW5kb3dSb3RhdGlvbkFuZ2xlIiwicnVuIiwicGxhdGZvcm1OYW1lIiwiUExBVEZPUk1fTkFNRV9UVk9TIiwiUExBVEZPUk1fTkFNRV9JT1MiLCJsYXVuY2hBcHAiLCJBUFBfTEFVTkNIX1RJTUVPVVQiLCJjaGVja1N0YXR1cyIsInJlc3BvbnNlIiwiY3VycmVudEFwcCIsImJ1bmRsZUlEIiwicGFyc2VJbnQiLCJpc0FycmF5Iiwic3RyaW5naWZ5IiwiZW52IiwiaXNQbGFpbk9iamVjdCIsInNob3VsZFdhaXRGb3JRdWllc2NlbmNlIiwid2FpdEZvclF1aWVzY2VuY2UiLCJtYXhUeXBpbmdGcmVxdWVuY3kiLCJzaG91bGRVc2VTaW5nbGV0b25UZXN0TWFuYWdlciIsInNob3VsZFVzZVRlc3RNYW5hZ2VyRm9yVmlzaWJpbGl0eURldGVjdGlvbiIsImV2ZW50bG9vcElkbGVEZWxheVNlYyIsIndkYUV2ZW50bG9vcElkbGVEZWxheSIsInNpbXBsZUlzVmlzaWJsZUNoZWNrIiwibGFuZ3VhZ2UiLCJwdXNoIiwibG9jYWxlIiwid2RhQ2FwcyIsImF1dG9MYXVuY2giLCJhcmd1bWVudHMiLCJlbnZpcm9ubWVudCIsImVsZW1lbnRSZXNwb25zZUZpZWxkcyIsImF1dG9BY2NlcHRBbGVydHMiLCJkZWZhdWx0QWxlcnRBY3Rpb24iLCJhdXRvRGlzbWlzc0FsZXJ0cyIsImNhcGFiaWxpdGllcyIsImZpcnN0TWF0Y2giLCJhbHdheXNNYXRjaCIsInByb3h5QWN0aXZlIiwiZ2V0UHJveHlBdm9pZExpc3QiLCJpc1dlYnZpZXciLCJjYW5Qcm94eSIsInZhbGlkYXRlTG9jYXRvclN0cmF0ZWd5Iiwic3RyYXRlZ3kiLCJ2YWxpZGF0ZURlc2lyZWRDYXBzIiwidmVyaWZ5UHJvY2Vzc0FyZ3VtZW50IiwiaXNOaWwiLCJrZXljaGFpblBhdGgiLCJrZXljaGFpblBhc3N3b3JkIiwiY29tbWFuZFRpbWVvdXRzIiwicHJvdG9jb2wiLCJob3N0IiwicGVybXMiLCJvdGhlckFwcHMiLCJpbnN0YWxsT3RoZXJBcHBzIiwiaW9zSW5zdGFsbFBhdXNlIiwicGF1c2UiLCJCIiwiZGVsYXkiLCJwYXJzZUNhcHNBcnJheSIsIm90aGVyQXBwIiwiaXNFbmFibGVkIiwiaXNCb29sZWFuIiwiY3VyT3JpZW50YXRpb24iLCJfZ2V0Q29tbWFuZFRpbWVvdXQiLCJjbWROYW1lIiwiREVGQVVMVF9USU1FT1VUX0tFWSIsImdldFNlc3Npb24iLCJkcml2ZXJTZXNzaW9uIiwiZGV2aWNlQ2FwcyIsInN0YXR1c0JhclNpemUiLCJzY2FsZSIsImdldFNjcmVlbkluZm8iLCJwaXhlbFJhdGlvIiwic3RhdEJhckhlaWdodCIsImhlaWdodCIsInZpZXdwb3J0UmVjdCIsImdldFZpZXdwb3J0UmVjdCIsInJlc2V0IiwiY2xvbmVEZWVwIiwic2h1dGRvd25IYW5kbGVyIiwicmVzZXRPblVuZXhwZWN0ZWRTaHV0ZG93biIsInByb3RvdHlwZSIsImNvbW1hbmRzIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7OztBQUFBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUdBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQU9BOztBQUdBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUdBLE1BQU1BLHdCQUF3QixHQUFHLHFCQUFqQztBQUNBLE1BQU1DLGdCQUFnQixHQUFHLHdCQUF6QjtBQUNBLE1BQU1DLHVCQUF1QixHQUFHLENBQWhDO0FBQ0EsTUFBTUMsNEJBQTRCLEdBQUcsQ0FBckM7QUFDQSxNQUFNQyx5QkFBeUIsR0FBRyx5RkFBbEM7QUFDQSxNQUFNQywwQkFBMEIsR0FBRyxLQUFu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QkFBTCxHQUFpQyxNQUFNLENBQUUsQ0FBekM7O0FBQ0EsVUFBSTtBQUNGLGNBQU0sS0FBS3BOLFFBQUwsQ0FBYzVGLElBQWQsQ0FBTjtBQUNELE9BRkQsU0FFVTtBQUNSLGFBQUtnVCx5QkFBTCxHQUFpQ0QsZUFBakM7QUFDRDtBQUNGOztBQUNELFVBQU0sTUFBTUYsS0FBTixFQUFOO0FBQ0Q7O0FBMWxDcUM7OztBQTZsQ3hDL1AsTUFBTSxDQUFDQyxNQUFQLENBQWNsRCxjQUFjLENBQUNvVCxTQUE3QixFQUF3Q0MsY0FBeEM7ZUFFZXJULGMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBCYXNlRHJpdmVyLCBEZXZpY2VTZXR0aW5ncyB9IGZyb20gJ2FwcGl1bS1iYXNlLWRyaXZlcic7XG5pbXBvcnQgeyB1dGlsLCBmcywgbWpwZWcgfSBmcm9tICdhcHBpdW0tc3VwcG9ydCc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHVybCBmcm9tICd1cmwnO1xuaW1wb3J0IHsgbGF1bmNoLCBvcGVuVXJsIH0gZnJvbSAnbm9kZS1zaW1jdGwnO1xuaW1wb3J0IFdlYkRyaXZlckFnZW50IGZyb20gJy4vd2RhL3dlYmRyaXZlcmFnZW50JztcbmltcG9ydCBsb2cgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IHtcbiAgY3JlYXRlU2ltLCBnZXRFeGlzdGluZ1NpbSwgcnVuU2ltdWxhdG9yUmVzZXQsIGluc3RhbGxUb1NpbXVsYXRvcixcbiAgc2h1dGRvd25PdGhlclNpbXVsYXRvcnMsIHNodXRkb3duU2ltdWxhdG9yIH0gZnJvbSAnLi9zaW11bGF0b3ItbWFuYWdlbWVudCc7XG5pbXBvcnQgeyBzaW1FeGlzdHMsIGdldFNpbXVsYXRvciwgaW5zdGFsbFNTTENlcnQsIGhhc1NTTENlcnQgfSBmcm9tICdhcHBpdW0taW9zLXNpbXVsYXRvcic7XG5pbXBvcnQgeyByZXRyeUludGVydmFsLCByZXRyeSB9IGZyb20gJ2FzeW5jYm94JztcbmltcG9ydCB7IHNldHRpbmdzIGFzIGlvc1NldHRpbmdzLCBkZWZhdWx0U2VydmVyQ2FwcywgYXBwVXRpbHMgfSBmcm9tICdhcHBpdW0taW9zLWRyaXZlcic7XG5pbXBvcnQgeyBkZXNpcmVkQ2FwQ29uc3RyYWludHMsIFBMQVRGT1JNX05BTUVfSU9TLCBQTEFURk9STV9OQU1FX1RWT1MgfSBmcm9tICcuL2Rlc2lyZWQtY2Fwcyc7XG5pbXBvcnQgY29tbWFuZHMgZnJvbSAnLi9jb21tYW5kcy9pbmRleCc7XG5pbXBvcnQge1xuICBkZXRlY3RVZGlkLCBnZXRBbmRDaGVja1hjb2RlVmVyc2lvbiwgZ2V0QW5kQ2hlY2tJb3NTZGtWZXJzaW9uLFxuICBjaGVja0FwcFByZXNlbnQsIGdldERyaXZlckluZm8sXG4gIGNsZWFyU3lzdGVtRmlsZXMsIHRyYW5zbGF0ZURldmljZU5hbWUsIG5vcm1hbGl6ZUNvbW1hbmRUaW1lb3V0cyxcbiAgREVGQVVMVF9USU1FT1VUX0tFWSwgbWFya1N5c3RlbUZpbGVzRm9yQ2xlYW51cCxcbiAgcHJpbnRVc2VyLCByZW1vdmVBbGxTZXNzaW9uV2ViU29ja2V0SGFuZGxlcnMsIHZlcmlmeUFwcGxpY2F0aW9uUGxhdGZvcm0sIGlzVHZPUyxcbiAgbm9ybWFsaXplUGxhdGZvcm1WZXJzaW9uLCBpc0xvY2FsSG9zdCB9IGZyb20gJy4vdXRpbHMnO1xuaW1wb3J0IHtcbiAgZ2V0Q29ubmVjdGVkRGV2aWNlcywgcnVuUmVhbERldmljZVJlc2V0LCBpbnN0YWxsVG9SZWFsRGV2aWNlLFxuICBnZXRSZWFsRGV2aWNlT2JqLCBnZXRPU1ZlcnNpb24gfSBmcm9tICcuL3JlYWwtZGV2aWNlLW1hbmFnZW1lbnQnO1xuaW1wb3J0IEIgZnJvbSAnYmx1ZWJpcmQnO1xuaW1wb3J0IEFzeW5jTG9jayBmcm9tICdhc3luYy1sb2NrJztcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IElEQiBmcm9tICdhcHBpdW0taWRiJztcbmltcG9ydCBERVZJQ0VfQ09OTkVDVElPTlNfRkFDVE9SWSBmcm9tICcuL2RldmljZS1jb25uZWN0aW9ucy1mYWN0b3J5JztcblxuXG5jb25zdCBTSFVURE9XTl9PVEhFUl9GRUFUX05BTUUgPSAnc2h1dGRvd25fb3RoZXJfc2ltcyc7XG5jb25zdCBTQUZBUklfQlVORExFX0lEID0gJ2NvbS5hcHBsZS5tb2JpbGVzYWZhcmknO1xuY29uc3QgV0RBX1NJTV9TVEFSVFVQX1JFVFJJRVMgPSAyO1xuY29uc3QgV0RBX1JFQUxfREVWX1NUQVJUVVBfUkVUUklFUyA9IDE7XG5jb25zdCBXREFfUkVBTF9ERVZfVFVUT1JJQUxfVVJMID0gJ2h0dHBzOi8vZ2l0aHViLmNvbS9hcHBpdW0vYXBwaXVtLXhjdWl0ZXN0LWRyaXZlci9ibG9iL21hc3Rlci9kb2NzL3JlYWwtZGV2aWNlLWNvbmZpZy5tZCc7XG5jb25zdCBXREFfU1RBUlRVUF9SRVRSWV9JTlRFUlZBTCA9IDEwMDAwO1xuY29uc3QgREVGQVVMVF9TRVRUSU5HUyA9IHtcbiAgbmF0aXZlV2ViVGFwOiBmYWxzZSxcbiAgdXNlSlNPTlNvdXJjZTogZmFsc2UsXG4gIHNob3VsZFVzZUNvbXBhY3RSZXNwb25zZXM6IHRydWUsXG4gIGVsZW1lbnRSZXNwb25zZUF0dHJpYnV0ZXM6ICd0eXBlLGxhYmVsJyxcbiAgLy8gUmVhZCBodHRwczovL2dpdGh1Yi5jb20vYXBwaXVtL1dlYkRyaXZlckFnZW50L2Jsb2IvbWFzdGVyL1dlYkRyaXZlckFnZW50TGliL1V0aWxpdGllcy9GQkNvbmZpZ3VyYXRpb24ubSBmb3IgZm9sbG93aW5nIHNldHRpbmdzJyB2YWx1ZXNcbiAgbWpwZWdTZXJ2ZXJTY3JlZW5zaG90UXVhbGl0eTogMjUsXG4gIG1qcGVnU2VydmVyRnJhbWVyYXRlOiAxMCxcbiAgc2NyZWVuc2hvdFF1YWxpdHk6IDEsXG4gIG1qcGVnU2NhbGluZ0ZhY3RvcjogMTAwLFxuICAvLyBzZXQgYHJlZHVjZU1vdGlvbmAgdG8gYG51bGxgIHNvIHRoYXQgaXQgd2lsbCBiZSB2ZXJpZmllZCBidXQgc3RpbGwgc2V0IGVpdGhlciB0cnVlL2ZhbHNlXG4gIHJlZHVjZU1vdGlvbjogbnVsbCxcbn07XG4vLyBUaGlzIGxvY2sgYXNzdXJlcywgdGhhdCBlYWNoIGRyaXZlciBzZXNzaW9uIGRvZXMgbm90XG4vLyBhZmZlY3Qgc2hhcmVkIHJlc291cmNlcyBvZiB0aGUgb3RoZXIgcGFyYWxsZWwgc2Vzc2lvbnNcbmNvbnN0IFNIQVJFRF9SRVNPVVJDRVNfR1VBUkQgPSBuZXcgQXN5bmNMb2NrKCk7XG5cbi8qIGVzbGludC1kaXNhYmxlIG5vLXVzZWxlc3MtZXNjYXBlICovXG5jb25zdCBOT19QUk9YWV9OQVRJVkVfTElTVCA9IFtcbiAgWydERUxFVEUnLCAvd2luZG93L10sXG4gIFsnR0VUJywgL15cXC9zZXNzaW9uXFwvW15cXC9dKyQvXSxcbiAgWydHRVQnLCAvYWxlcnRfdGV4dC9dLFxuICBbJ0dFVCcsIC9hbGVydFxcL1teXFwvXSsvXSxcbiAgWydHRVQnLCAvYXBwaXVtL10sXG4gIFsnR0VUJywgL2F0dHJpYnV0ZS9dLFxuICBbJ0dFVCcsIC9jb250ZXh0L10sXG4gIFsnR0VUJywgL2xvY2F0aW9uL10sXG4gIFsnR0VUJywgL2xvZy9dLFxuICBbJ0dFVCcsIC9zY3JlZW5zaG90L10sXG4gIFsnR0VUJywgL3NpemUvXSxcbiAgWydHRVQnLCAvc291cmNlL10sXG4gIFsnR0VUJywgL3RpbWVvdXRzJC9dLFxuICBbJ0dFVCcsIC91cmwvXSxcbiAgWydHRVQnLCAvd2luZG93L10sXG4gIFsnUE9TVCcsIC9hY2NlcHRfYWxlcnQvXSxcbiAgWydQT1NUJywgL2FjdGlvbnMkL10sXG4gIFsnUE9TVCcsIC9hbGVydF90ZXh0L10sXG4gIFsnUE9TVCcsIC9hbGVydFxcL1teXFwvXSsvXSxcbiAgWydQT1NUJywgL2FwcGl1bS9dLFxuICBbJ1BPU1QnLCAvYXBwaXVtXFwvZGV2aWNlXFwvaXNfbG9ja2VkL10sXG4gIFsnUE9TVCcsIC9hcHBpdW1cXC9kZXZpY2VcXC9sb2NrL10sXG4gIFsnUE9TVCcsIC9hcHBpdW1cXC9kZXZpY2VcXC91bmxvY2svXSxcbiAgWydQT1NUJywgL2JhY2svXSxcbiAgWydQT1NUJywgL2NsZWFyL10sXG4gIFsnUE9TVCcsIC9jb250ZXh0L10sXG4gIFsnUE9TVCcsIC9kaXNtaXNzX2FsZXJ0L10sXG4gIFsnUE9TVCcsIC9lbGVtZW50XFwvYWN0aXZlL10sIC8vIE1KU09OV1AgZ2V0IGFjdGl2ZSBlbGVtZW50IHNob3VsZCBwcm94eVxuICBbJ1BPU1QnLCAvZWxlbWVudCQvXSxcbiAgWydQT1NUJywgL2VsZW1lbnRzJC9dLFxuICBbJ1BPU1QnLCAvZXhlY3V0ZS9dLFxuICBbJ1BPU1QnLCAva2V5cy9dLFxuICBbJ1BPU1QnLCAvbG9nL10sXG4gIFsnUE9TVCcsIC9tb3ZldG8vXSxcbiAgWydQT1NUJywgL3JlY2VpdmVfYXN5bmNfcmVzcG9uc2UvXSwgLy8gYWx3YXlzLCBpbiBjYXNlIGNvbnRleHQgc3dpdGNoZXMgd2hpbGUgd2FpdGluZ1xuICBbJ1BPU1QnLCAvc2Vzc2lvblxcL1teXFwvXStcXC9sb2NhdGlvbi9dLCAvLyBnZW8gbG9jYXRpb24sIGJ1dCBub3QgZWxlbWVudCBsb2NhdGlvblxuICBbJ1BPU1QnLCAvc2hha2UvXSxcbiAgWydQT1NUJywgL3RpbWVvdXRzL10sXG4gIFsnUE9TVCcsIC90b3VjaC9dLFxuICBbJ1BPU1QnLCAvdXJsL10sXG4gIFsnUE9TVCcsIC92YWx1ZS9dLFxuICBbJ1BPU1QnLCAvd2luZG93L10sXG5dO1xuY29uc3QgTk9fUFJPWFlfV0VCX0xJU1QgPSBbXG4gIFsnREVMRVRFJywgL2Nvb2tpZS9dLFxuICBbJ0dFVCcsIC9hdHRyaWJ1dGUvXSxcbiAgWydHRVQnLCAvY29va2llL10sXG4gIFsnR0VUJywgL2VsZW1lbnQvXSxcbiAgWydHRVQnLCAvdGV4dC9dLFxuICBbJ0dFVCcsIC90aXRsZS9dLFxuICBbJ1BPU1QnLCAvY2xlYXIvXSxcbiAgWydQT1NUJywgL2NsaWNrL10sXG4gIFsnUE9TVCcsIC9jb29raWUvXSxcbiAgWydQT1NUJywgL2VsZW1lbnQvXSxcbiAgWydQT1NUJywgL2ZvcndhcmQvXSxcbiAgWydQT1NUJywgL2ZyYW1lL10sXG4gIFsnUE9TVCcsIC9rZXlzL10sXG4gIFsnUE9TVCcsIC9yZWZyZXNoL10sXG5dLmNvbmNhdChOT19QUk9YWV9OQVRJVkVfTElTVCk7XG4vKiBlc2xpbnQtZW5hYmxlIG5vLXVzZWxlc3MtZXNjYXBlICovXG5cbmNvbnN0IE1FTU9JWkVEX0ZVTkNUSU9OUyA9IFtcbiAgJ2dldFN0YXR1c0JhckhlaWdodCcsXG4gICdnZXREZXZpY2VQaXhlbFJhdGlvJyxcbiAgJ2dldFNjcmVlbkluZm8nLFxuICAnZ2V0U2FmYXJpSXNJcGhvbmUnLFxuICAnZ2V0U2FmYXJpSXNJcGhvbmVYJyxcbl07XG5cbmNsYXNzIFhDVUlUZXN0RHJpdmVyIGV4dGVuZHMgQmFzZURyaXZlciB7XG4gIGNvbnN0cnVjdG9yIChvcHRzID0ge30sIHNob3VsZFZhbGlkYXRlQ2FwcyA9IHRydWUpIHtcbiAgICBzdXBlcihvcHRzLCBzaG91bGRWYWxpZGF0ZUNhcHMpO1xuXG4gICAgdGhpcy5kZXNpcmVkQ2FwQ29uc3RyYWludHMgPSBkZXNpcmVkQ2FwQ29uc3RyYWludHM7XG5cbiAgICB0aGlzLmxvY2F0b3JTdHJhdGVnaWVzID0gW1xuICAgICAgJ3hwYXRoJyxcbiAgICAgICdpZCcsXG4gICAgICAnbmFtZScsXG4gICAgICAnY2xhc3MgbmFtZScsXG4gICAgICAnLWlvcyBwcmVkaWNhdGUgc3RyaW5nJyxcbiAgICAgICctaW9zIGNsYXNzIGNoYWluJyxcbiAgICAgICdhY2Nlc3NpYmlsaXR5IGlkJ1xuICAgIF07XG4gICAgdGhpcy53ZWJMb2NhdG9yU3RyYXRlZ2llcyA9IFtcbiAgICAgICdsaW5rIHRleHQnLFxuICAgICAgJ2NzcyBzZWxlY3RvcicsXG4gICAgICAndGFnIG5hbWUnLFxuICAgICAgJ2xpbmsgdGV4dCcsXG4gICAgICAncGFydGlhbCBsaW5rIHRleHQnXG4gICAgXTtcbiAgICB0aGlzLnJlc2V0SW9zKCk7XG4gICAgdGhpcy5zZXR0aW5ncyA9IG5ldyBEZXZpY2VTZXR0aW5ncyhERUZBVUxUX1NFVFRJTkdTLCB0aGlzLm9uU2V0dGluZ3NVcGRhdGUuYmluZCh0aGlzKSk7XG4gICAgdGhpcy5sb2dzID0ge307XG5cbiAgICAvLyBtZW1vaXplIGZ1bmN0aW9ucyBoZXJlLCBzbyB0aGF0IHRoZXkgYXJlIGRvbmUgb24gYSBwZXItaW5zdGFuY2UgYmFzaXNcbiAgICBmb3IgKGNvbnN0IGZuIG9mIE1FTU9JWkVEX0ZVTkNUSU9OUykge1xuICAgICAgdGhpc1tmbl0gPSBfLm1lbW9pemUodGhpc1tmbl0pO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIG9uU2V0dGluZ3NVcGRhdGUgKGtleSwgdmFsdWUpIHtcbiAgICBpZiAoa2V5ICE9PSAnbmF0aXZlV2ViVGFwJykge1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMucHJveHlDb21tYW5kKCcvYXBwaXVtL3NldHRpbmdzJywgJ1BPU1QnLCB7XG4gICAgICAgIHNldHRpbmdzOiB7W2tleV06IHZhbHVlfVxuICAgICAgfSk7XG4gICAgfVxuICAgIHRoaXMub3B0cy5uYXRpdmVXZWJUYXAgPSAhIXZhbHVlO1xuICB9XG5cbiAgcmVzZXRJb3MgKCkge1xuICAgIHRoaXMub3B0cyA9IHRoaXMub3B0cyB8fCB7fTtcbiAgICB0aGlzLndkYSA9IG51bGw7XG4gICAgdGhpcy5vcHRzLmRldmljZSA9IG51bGw7XG4gICAgdGhpcy5qd3BQcm94eUFjdGl2ZSA9IGZhbHNlO1xuICAgIHRoaXMucHJveHlSZXFSZXMgPSBudWxsO1xuICAgIHRoaXMuandwUHJveHlBdm9pZCA9IFtdO1xuICAgIHRoaXMuc2FmYXJpID0gZmFsc2U7XG4gICAgdGhpcy5jYWNoZWRXZGFTdGF0dXMgPSBudWxsO1xuXG4gICAgLy8gc29tZSB0aGluZ3MgdGhhdCBjb21tYW5kcyBpbXBvcnRlZCBmcm9tIGFwcGl1bS1pb3MtZHJpdmVyIG5lZWRcbiAgICB0aGlzLmN1cldlYkZyYW1lcyA9IFtdO1xuICAgIHRoaXMud2ViRWxlbWVudElkcyA9IFtdO1xuICAgIHRoaXMuX2N1cnJlbnRVcmwgPSBudWxsO1xuICAgIHRoaXMuY3VyQ29udGV4dCA9IG51bGw7XG4gICAgdGhpcy54Y29kZVZlcnNpb24gPSB7fTtcbiAgICB0aGlzLmNvbnRleHRzID0gW107XG4gICAgdGhpcy5pbXBsaWNpdFdhaXRNcyA9IDA7XG4gICAgdGhpcy5hc3luY2xpYldhaXRNcyA9IDA7XG4gICAgdGhpcy5wYWdlTG9hZE1zID0gNjAwMDtcbiAgICB0aGlzLmxhbmRzY2FwZVdlYkNvb3Jkc09mZnNldCA9IDA7XG4gIH1cblxuICBnZXQgZHJpdmVyRGF0YSAoKSB7XG4gICAgLy8gVE9ETyBmaWxsIG91dCByZXNvdXJjZSBpbmZvIGhlcmVcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBhc3luYyBnZXRTdGF0dXMgKCkge1xuICAgIGlmICh0eXBlb2YgdGhpcy5kcml2ZXJJbmZvID09PSAndW5kZWZpbmVkJykge1xuICAgICAgdGhpcy5kcml2ZXJJbmZvID0gYXdhaXQgZ2V0RHJpdmVySW5mbygpO1xuICAgIH1cbiAgICBsZXQgc3RhdHVzID0ge2J1aWxkOiB7dmVyc2lvbjogdGhpcy5kcml2ZXJJbmZvLnZlcnNpb259fTtcbiAgICBpZiAodGhpcy5jYWNoZWRXZGFTdGF0dXMpIHtcbiAgICAgIHN0YXR1cy53ZGEgPSB0aGlzLmNhY2hlZFdkYVN0YXR1cztcbiAgICB9XG4gICAgcmV0dXJuIHN0YXR1cztcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZVNlc3Npb24gKC4uLmFyZ3MpIHtcbiAgICB0aGlzLmxpZmVjeWNsZURhdGEgPSB7fTsgLy8gdGhpcyBpcyB1c2VkIGZvciBrZWVwaW5nIHRyYWNrIG9mIHRoZSBzdGF0ZSB3ZSBzdGFydCBzbyB3aGVuIHdlIGRlbGV0ZSB0aGUgc2Vzc2lvbiB3ZSBjYW4gcHV0IHRoaW5ncyBiYWNrXG4gICAgdHJ5IHtcbiAgICAgIC8vIFRPRE8gYWRkIHZhbGlkYXRpb24gb24gY2Fwc1xuICAgICAgbGV0IFtzZXNzaW9uSWQsIGNhcHNdID0gYXdhaXQgc3VwZXIuY3JlYXRlU2Vzc2lvbiguLi5hcmdzKTtcbiAgICAgIHRoaXMub3B0cy5zZXNzaW9uSWQgPSBzZXNzaW9uSWQ7XG5cbiAgICAgIGF3YWl0IHRoaXMuc3RhcnQoKTtcblxuICAgICAgLy8gbWVyZ2Ugc2VydmVyIGNhcGFiaWxpdGllcyArIGRlc2lyZWQgY2FwYWJpbGl0aWVzXG4gICAgICBjYXBzID0gT2JqZWN0LmFzc2lnbih7fSwgZGVmYXVsdFNlcnZlckNhcHMsIGNhcHMpO1xuICAgICAgLy8gdXBkYXRlIHRoZSB1ZGlkIHdpdGggd2hhdCBpcyBhY3R1YWxseSB1c2VkXG4gICAgICBjYXBzLnVkaWQgPSB0aGlzLm9wdHMudWRpZDtcbiAgICAgIC8vIGVuc3VyZSB3ZSB0cmFjayBuYXRpdmVXZWJUYXAgY2FwYWJpbGl0eSBhcyBhIHNldHRpbmcgYXMgd2VsbFxuICAgICAgaWYgKF8uaGFzKHRoaXMub3B0cywgJ25hdGl2ZVdlYlRhcCcpKSB7XG4gICAgICAgIGF3YWl0IHRoaXMudXBkYXRlU2V0dGluZ3Moe25hdGl2ZVdlYlRhcDogdGhpcy5vcHRzLm5hdGl2ZVdlYlRhcH0pO1xuICAgICAgfVxuICAgICAgLy8gZW5zdXJlIHdlIHRyYWNrIHVzZUpTT05Tb3VyY2UgY2FwYWJpbGl0eSBhcyBhIHNldHRpbmcgYXMgd2VsbFxuICAgICAgaWYgKF8uaGFzKHRoaXMub3B0cywgJ3VzZUpTT05Tb3VyY2UnKSkge1xuICAgICAgICBhd2FpdCB0aGlzLnVwZGF0ZVNldHRpbmdzKHt1c2VKU09OU291cmNlOiB0aGlzLm9wdHMudXNlSlNPTlNvdXJjZX0pO1xuICAgICAgfVxuXG4gICAgICBsZXQgd2RhU2V0dGluZ3MgPSB7XG4gICAgICAgIGVsZW1lbnRSZXNwb25zZUF0dHJpYnV0ZXM6IERFRkFVTFRfU0VUVElOR1MuZWxlbWVudFJlc3BvbnNlQXR0cmlidXRlcyxcbiAgICAgICAgc2hvdWxkVXNlQ29tcGFjdFJlc3BvbnNlczogREVGQVVMVF9TRVRUSU5HUy5zaG91bGRVc2VDb21wYWN0UmVzcG9uc2VzLFxuICAgICAgfTtcbiAgICAgIGlmIChfLmhhcyh0aGlzLm9wdHMsICdlbGVtZW50UmVzcG9uc2VBdHRyaWJ1dGVzJykpIHtcbiAgICAgICAgd2RhU2V0dGluZ3MuZWxlbWVudFJlc3BvbnNlQXR0cmlidXRlcyA9IHRoaXMub3B0cy5lbGVtZW50UmVzcG9uc2VBdHRyaWJ1dGVzO1xuICAgICAgfVxuICAgICAgaWYgKF8uaGFzKHRoaXMub3B0cywgJ3Nob3VsZFVzZUNvbXBhY3RSZXNwb25zZXMnKSkge1xuICAgICAgICB3ZGFTZXR0aW5ncy5zaG91bGRVc2VDb21wYWN0UmVzcG9uc2VzID0gdGhpcy5vcHRzLnNob3VsZFVzZUNvbXBhY3RSZXNwb25zZXM7XG4gICAgICB9XG4gICAgICBpZiAoXy5oYXModGhpcy5vcHRzLCAnbWpwZWdTZXJ2ZXJTY3JlZW5zaG90UXVhbGl0eScpKSB7XG4gICAgICAgIHdkYVNldHRpbmdzLm1qcGVnU2VydmVyU2NyZWVuc2hvdFF1YWxpdHkgPSB0aGlzLm9wdHMubWpwZWdTZXJ2ZXJTY3JlZW5zaG90UXVhbGl0eTtcbiAgICAgIH1cbiAgICAgIGlmIChfLmhhcyh0aGlzLm9wdHMsICdtanBlZ1NlcnZlckZyYW1lcmF0ZScpKSB7XG4gICAgICAgIHdkYVNldHRpbmdzLm1qcGVnU2VydmVyRnJhbWVyYXRlID0gdGhpcy5vcHRzLm1qcGVnU2VydmVyRnJhbWVyYXRlO1xuICAgICAgfVxuICAgICAgaWYgKF8uaGFzKHRoaXMub3B0cywgJ3NjcmVlbnNob3RRdWFsaXR5JykpIHtcbiAgICAgICAgbG9nLmluZm8oYFNldHRpbmcgdGhlIHF1YWxpdHkgb2YgcGhvbmUgc2NyZWVuc2hvdDogJyR7dGhpcy5vcHRzLnNjcmVlbnNob3RRdWFsaXR5fSdgKTtcbiAgICAgICAgd2RhU2V0dGluZ3Muc2NyZWVuc2hvdFF1YWxpdHkgPSB0aGlzLm9wdHMuc2NyZWVuc2hvdFF1YWxpdHk7XG4gICAgICB9XG4gICAgICAvLyBlbnN1cmUgV0RBIGdldHMgb3VyIGRlZmF1bHRzIGluc3RlYWQgb2Ygd2hhdGV2ZXIgaXRzIG93biBtaWdodCBiZVxuICAgICAgYXdhaXQgdGhpcy51cGRhdGVTZXR0aW5ncyh3ZGFTZXR0aW5ncyk7XG5cbiAgICAgIC8vIHR1cm4gb24gbWpwZWcgc3RyZWFtIHJlYWRpbmcgaWYgcmVxdWVzdGVkXG4gICAgICBpZiAodGhpcy5vcHRzLm1qcGVnU2NyZWVuc2hvdFVybCkge1xuICAgICAgICBsb2cuaW5mbyhgU3RhcnRpbmcgTUpQRUcgc3RyZWFtIHJlYWRpbmcgVVJMOiAnJHt0aGlzLm9wdHMubWpwZWdTY3JlZW5zaG90VXJsfSdgKTtcbiAgICAgICAgdGhpcy5tanBlZ1N0cmVhbSA9IG5ldyBtanBlZy5NSnBlZ1N0cmVhbSh0aGlzLm9wdHMubWpwZWdTY3JlZW5zaG90VXJsKTtcbiAgICAgICAgYXdhaXQgdGhpcy5tanBlZ1N0cmVhbS5zdGFydCgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIFtzZXNzaW9uSWQsIGNhcHNdO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGxvZy5lcnJvcihlKTtcbiAgICAgIGF3YWl0IHRoaXMuZGVsZXRlU2Vzc2lvbigpO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBzdGFydCAoKSB7XG4gICAgdGhpcy5vcHRzLm5vUmVzZXQgPSAhIXRoaXMub3B0cy5ub1Jlc2V0O1xuICAgIHRoaXMub3B0cy5mdWxsUmVzZXQgPSAhIXRoaXMub3B0cy5mdWxsUmVzZXQ7XG5cbiAgICBhd2FpdCBwcmludFVzZXIoKTtcblxuICAgIHRoaXMub3B0cy5pb3NTZGtWZXJzaW9uID0gbnVsbDsgLy8gRm9yIFdEQSBhbmQgeGNvZGVidWlsZFxuICAgIGNvbnN0IHtkZXZpY2UsIHVkaWQsIHJlYWxEZXZpY2V9ID0gYXdhaXQgdGhpcy5kZXRlcm1pbmVEZXZpY2UoKTtcbiAgICBsb2cuaW5mbyhgRGV0ZXJtaW5pbmcgZGV2aWNlIHRvIHJ1biB0ZXN0cyBvbjogdWRpZDogJyR7dWRpZH0nLCByZWFsIGRldmljZTogJHtyZWFsRGV2aWNlfWApO1xuICAgIHRoaXMub3B0cy5kZXZpY2UgPSBkZXZpY2U7XG4gICAgdGhpcy5vcHRzLnVkaWQgPSB1ZGlkO1xuICAgIHRoaXMub3B0cy5yZWFsRGV2aWNlID0gcmVhbERldmljZTtcblxuICAgIGNvbnN0IG5vcm1hbGl6ZWRWZXJzaW9uID0gbm9ybWFsaXplUGxhdGZvcm1WZXJzaW9uKHRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24pO1xuICAgIGlmICh0aGlzLm9wdHMucGxhdGZvcm1WZXJzaW9uICE9PSBub3JtYWxpemVkVmVyc2lvbikge1xuICAgICAgbG9nLmluZm8oYE5vcm1hbGl6ZWQgcGxhdGZvcm1WZXJzaW9uIGNhcGFiaWxpdHkgdmFsdWUgJyR7dGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbn0nIHRvICcke25vcm1hbGl6ZWRWZXJzaW9ufSdgKTtcbiAgICAgIHRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24gPSBub3JtYWxpemVkVmVyc2lvbjtcbiAgICB9XG4gICAgaWYgKHV0aWwuY29tcGFyZVZlcnNpb25zKHRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24sICc8JywgJzkuMycpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFBsYXRmb3JtIHZlcnNpb24gbXVzdCBiZSA5LjMgb3IgYWJvdmUuICcke3RoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb259JyBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgIH1cblxuICAgIGlmIChfLmlzRW1wdHkodGhpcy54Y29kZVZlcnNpb24pICYmICghdGhpcy5vcHRzLndlYkRyaXZlckFnZW50VXJsIHx8ICF0aGlzLm9wdHMucmVhbERldmljZSkpIHtcbiAgICAgIC8vIG5vIGB3ZWJEcml2ZXJBZ2VudFVybGAsIG9yIG9uIGEgc2ltdWxhdG9yLCBzbyB3ZSBuZWVkIGFuIFhjb2RlIHZlcnNpb25cbiAgICAgIHRoaXMueGNvZGVWZXJzaW9uID0gYXdhaXQgZ2V0QW5kQ2hlY2tYY29kZVZlcnNpb24oKTtcbiAgICB9XG4gICAgdGhpcy5sb2dFdmVudCgneGNvZGVEZXRhaWxzUmV0cmlldmVkJyk7XG5cbiAgICBpZiAodGhpcy5vcHRzLmVuYWJsZUFzeW5jRXhlY3V0ZUZyb21IdHRwcyAmJiAhdGhpcy5pc1JlYWxEZXZpY2UoKSkge1xuICAgICAgLy8gc2h1dGRvd24gdGhlIHNpbXVsYXRvciBzbyB0aGF0IHRoZSBzc2wgY2VydCBpcyByZWNvZ25pemVkXG4gICAgICBhd2FpdCBzaHV0ZG93blNpbXVsYXRvcih0aGlzLm9wdHMuZGV2aWNlKTtcbiAgICAgIGF3YWl0IHRoaXMuc3RhcnRIdHRwc0FzeW5jU2VydmVyKCk7XG4gICAgfVxuXG4gICAgLy8gYXQgdGhpcyBwb2ludCBpZiB0aGVyZSBpcyBubyBwbGF0Zm9ybVZlcnNpb24sIGdldCBpdCBmcm9tIHRoZSBkZXZpY2VcbiAgICBpZiAoIXRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24pIHtcbiAgICAgIGlmICh0aGlzLm9wdHMuZGV2aWNlICYmIF8uaXNGdW5jdGlvbih0aGlzLm9wdHMuZGV2aWNlLmdldFBsYXRmb3JtVmVyc2lvbikpIHtcbiAgICAgICAgdGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbiA9IGF3YWl0IHRoaXMub3B0cy5kZXZpY2UuZ2V0UGxhdGZvcm1WZXJzaW9uKCk7XG4gICAgICAgIGxvZy5pbmZvKGBObyBwbGF0Zm9ybVZlcnNpb24gc3BlY2lmaWVkLiBVc2luZyBkZXZpY2UgdmVyc2lvbjogJyR7dGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbn0nYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBUT0RPOiB0aGlzIGlzIHdoZW4gaXQgaXMgYSByZWFsIGRldmljZS4gd2hlbiB3ZSBoYXZlIGEgcmVhbCBvYmplY3Qgd2lyZSBpdCBpblxuICAgICAgfVxuICAgIH1cblxuICAgIGlmICgodGhpcy5vcHRzLmJyb3dzZXJOYW1lIHx8ICcnKS50b0xvd2VyQ2FzZSgpID09PSAnc2FmYXJpJykge1xuICAgICAgbG9nLmluZm8oJ1NhZmFyaSB0ZXN0IHJlcXVlc3RlZCcpO1xuICAgICAgdGhpcy5zYWZhcmkgPSB0cnVlO1xuICAgICAgdGhpcy5vcHRzLmFwcCA9IHVuZGVmaW5lZDtcbiAgICAgIHRoaXMub3B0cy5wcm9jZXNzQXJndW1lbnRzID0gdGhpcy5vcHRzLnByb2Nlc3NBcmd1bWVudHMgfHwge307XG4gICAgICB0aGlzLm9wdHMuYnVuZGxlSWQgPSBTQUZBUklfQlVORExFX0lEO1xuICAgICAgdGhpcy5fY3VycmVudFVybCA9IHRoaXMub3B0cy5zYWZhcmlJbml0aWFsVXJsIHx8IChcbiAgICAgICAgdGhpcy5pc1JlYWxEZXZpY2UoKVxuICAgICAgICAgID8gJ2h0dHA6Ly9hcHBpdW0uaW8nXG4gICAgICAgICAgOiBgaHR0cDovLyR7dGhpcy5vcHRzLmFkZHJlc3N9OiR7dGhpcy5vcHRzLnBvcnR9L3dlbGNvbWVgXG4gICAgICApO1xuICAgICAgaWYgKHV0aWwuY29tcGFyZVZlcnNpb25zKHRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24sICc8JywgJzEyLjInKSkge1xuICAgICAgICAvLyB0aGlzIG9wdGlvbiBkb2VzIG5vdCB3b3JrIG9uIDEyLjIgYW5kIGFib3ZlXG4gICAgICAgIHRoaXMub3B0cy5wcm9jZXNzQXJndW1lbnRzLmFyZ3MgPSBbJy11JywgdGhpcy5fY3VycmVudFVybF07XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGF3YWl0IHRoaXMuY29uZmlndXJlQXBwKCk7XG4gICAgfVxuICAgIHRoaXMubG9nRXZlbnQoJ2FwcENvbmZpZ3VyZWQnKTtcblxuICAgIC8vIGZhaWwgdmVyeSBlYXJseSBpZiB0aGUgYXBwIGRvZXNuJ3QgYWN0dWFsbHkgZXhpc3RcbiAgICAvLyBvciBpZiBidW5kbGUgaWQgZG9lc24ndCBwb2ludCB0byBhbiBpbnN0YWxsZWQgYXBwXG4gICAgaWYgKHRoaXMub3B0cy5hcHApIHtcbiAgICAgIGF3YWl0IGNoZWNrQXBwUHJlc2VudCh0aGlzLm9wdHMuYXBwKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMub3B0cy5idW5kbGVJZCkge1xuICAgICAgdGhpcy5vcHRzLmJ1bmRsZUlkID0gYXdhaXQgYXBwVXRpbHMuZXh0cmFjdEJ1bmRsZUlkKHRoaXMub3B0cy5hcHApO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMucnVuUmVzZXQoKTtcblxuICAgIGNvbnN0IG1lbW9pemVkTG9nSW5mbyA9IF8ubWVtb2l6ZShmdW5jdGlvbiBsb2dJbmZvICgpIHtcbiAgICAgIGxvZy5pbmZvKFwiJ3NraXBMb2dDYXB0dXJlJyBpcyBzZXQuIFNraXBwaW5nIHN0YXJ0aW5nIGxvZ3Mgc3VjaCBhcyBjcmFzaCwgc3lzdGVtLCBzYWZhcmkgY29uc29sZSBhbmQgc2FmYXJpIG5ldHdvcmsuXCIpO1xuICAgIH0pO1xuICAgIGNvbnN0IHN0YXJ0TG9nQ2FwdHVyZSA9IGFzeW5jICgpID0+IHtcbiAgICAgIGlmICh0aGlzLm9wdHMuc2tpcExvZ0NhcHR1cmUpIHtcbiAgICAgICAgbWVtb2l6ZWRMb2dJbmZvKCk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5zdGFydExvZ0NhcHR1cmUoKTtcbiAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgdGhpcy5sb2dFdmVudCgnbG9nQ2FwdHVyZVN0YXJ0ZWQnKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfTtcbiAgICBjb25zdCBpc0xvZ0NhcHR1cmVTdGFydGVkID0gYXdhaXQgc3RhcnRMb2dDYXB0dXJlKCk7XG5cbiAgICBsb2cuaW5mbyhgU2V0dGluZyB1cCAke3RoaXMuaXNSZWFsRGV2aWNlKCkgPyAncmVhbCBkZXZpY2UnIDogJ3NpbXVsYXRvcid9YCk7XG5cbiAgICBpZiAodGhpcy5pc1NpbXVsYXRvcigpKSB7XG4gICAgICBpZiAodGhpcy5vcHRzLnNodXRkb3duT3RoZXJTaW11bGF0b3JzKSB7XG4gICAgICAgIHRoaXMuZW5zdXJlRmVhdHVyZUVuYWJsZWQoU0hVVERPV05fT1RIRVJfRkVBVF9OQU1FKTtcbiAgICAgICAgYXdhaXQgc2h1dGRvd25PdGhlclNpbXVsYXRvcnModGhpcy5vcHRzLmRldmljZSk7XG4gICAgICB9XG5cbiAgICAgIC8vIHRoaXMgc2hvdWxkIGJlIGRvbmUgYmVmb3JlIHRoZSBzaW11bGF0b3IgaXMgc3RhcnRlZFxuICAgICAgLy8gaWYgaXQgaXMgYWxyZWFkeSBydW5uaW5nLCB0aGlzIGNhcCB3b24ndCB3b3JrLCB3aGljaCBpcyBkb2N1bWVudGVkXG4gICAgICBpZiAodGhpcy5pc1NhZmFyaSgpICYmIHRoaXMub3B0cy5zYWZhcmlHbG9iYWxQcmVmZXJlbmNlcykge1xuICAgICAgICBpZiAoYXdhaXQgdGhpcy5vcHRzLmRldmljZS51cGRhdGVTYWZhcmlHbG9iYWxTZXR0aW5ncyh0aGlzLm9wdHMuc2FmYXJpR2xvYmFsUHJlZmVyZW5jZXMpKSB7XG4gICAgICAgICAgbG9nLmRlYnVnKGBTYWZhcmkgZ2xvYmFsIHByZWZlcmVuY2VzIHVwZGF0ZWRgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0aGlzLmxvY2FsQ29uZmlnID0gYXdhaXQgaW9zU2V0dGluZ3Muc2V0TG9jYWxlQW5kUHJlZmVyZW5jZXModGhpcy5vcHRzLmRldmljZSwgdGhpcy5vcHRzLCB0aGlzLmlzU2FmYXJpKCksIGFzeW5jIChzaW0pID0+IHtcbiAgICAgICAgYXdhaXQgc2h1dGRvd25TaW11bGF0b3Ioc2ltKTtcblxuICAgICAgICAvLyB3ZSBkb24ndCBrbm93IGlmIHRoZXJlIG5lZWRzIHRvIGJlIGNoYW5nZXMgYSBwcmlvcmksIHNvIGNoYW5nZSBmaXJzdC5cbiAgICAgICAgLy8gc29tZXRpbWVzIHRoZSBzaHV0ZG93biBwcm9jZXNzIGNoYW5nZXMgdGhlIHNldHRpbmdzLCBzbyByZXNldCB0aGVtLFxuICAgICAgICAvLyBrbm93aW5nIHRoYXQgdGhlIHNpbSBpcyBhbHJlYWR5IHNodXRcbiAgICAgICAgYXdhaXQgaW9zU2V0dGluZ3Muc2V0TG9jYWxlQW5kUHJlZmVyZW5jZXMoc2ltLCB0aGlzLm9wdHMsIHRoaXMuaXNTYWZhcmkoKSk7XG4gICAgICB9KTtcblxuICAgICAgYXdhaXQgdGhpcy5zdGFydFNpbSgpO1xuXG4gICAgICBpZiAodGhpcy5vcHRzLmN1c3RvbVNTTENlcnQpIHtcbiAgICAgICAgaWYgKGF3YWl0IGhhc1NTTENlcnQodGhpcy5vcHRzLmN1c3RvbVNTTENlcnQsIHRoaXMub3B0cy51ZGlkKSkge1xuICAgICAgICAgIGxvZy5pbmZvKGBTU0wgY2VydCAnJHtfLnRydW5jYXRlKHRoaXMub3B0cy5jdXN0b21TU0xDZXJ0LCB7bGVuZ3RoOiAyMH0pfScgYWxyZWFkeSBpbnN0YWxsZWRgKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsb2cuaW5mbyhgSW5zdGFsbGluZyBzc2wgY2VydCAnJHtfLnRydW5jYXRlKHRoaXMub3B0cy5jdXN0b21TU0xDZXJ0LCB7bGVuZ3RoOiAyMH0pfSdgKTtcbiAgICAgICAgICBhd2FpdCBzaHV0ZG93blNpbXVsYXRvcih0aGlzLm9wdHMuZGV2aWNlKTtcbiAgICAgICAgICBhd2FpdCBpbnN0YWxsU1NMQ2VydCh0aGlzLm9wdHMuY3VzdG9tU1NMQ2VydCwgdGhpcy5vcHRzLnVkaWQpO1xuICAgICAgICAgIGxvZy5pbmZvKGBSZXN0YXJ0aW5nIFNpbXVsYXRvciBzbyB0aGF0IFNTTCBjZXJ0aWZpY2F0ZSBpbnN0YWxsYXRpb24gdGFrZXMgZWZmZWN0YCk7XG4gICAgICAgICAgYXdhaXQgdGhpcy5zdGFydFNpbSgpO1xuICAgICAgICAgIHRoaXMubG9nRXZlbnQoJ2N1c3RvbUNlcnRJbnN0YWxsZWQnKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBpZGIgPSBuZXcgSURCKHt1ZGlkfSk7XG4gICAgICAgIGF3YWl0IGlkYi5jb25uZWN0KCk7XG4gICAgICAgIHRoaXMub3B0cy5kZXZpY2UuaWRiID0gaWRiO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2cuaW5mbyhgaWRiIHdpbGwgbm90IGJlIHVzZWQgZm9yIFNpbXVsYXRvciBpbnRlcmFjdGlvbi4gT3JpZ2luYWwgZXJyb3I6ICR7ZS5tZXNzYWdlfWApO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmxvZ0V2ZW50KCdzaW1TdGFydGVkJyk7XG4gICAgICBpZiAoIWlzTG9nQ2FwdHVyZVN0YXJ0ZWQpIHtcbiAgICAgICAgLy8gUmV0cnkgbG9nIGNhcHR1cmUgaWYgU2ltdWxhdG9yIHdhcyBub3QgcnVubmluZyBiZWZvcmVcbiAgICAgICAgYXdhaXQgc3RhcnRMb2dDYXB0dXJlKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0cy5hcHApIHtcbiAgICAgIGF3YWl0IHRoaXMuaW5zdGFsbEFVVCgpO1xuICAgICAgdGhpcy5sb2dFdmVudCgnYXBwSW5zdGFsbGVkJyk7XG4gICAgfVxuXG4gICAgLy8gaWYgd2Ugb25seSBoYXZlIGJ1bmRsZSBpZGVudGlmaWVyIGFuZCBubyBhcHAsIGZhaWwgaWYgaXQgaXMgbm90IGFscmVhZHkgaW5zdGFsbGVkXG4gICAgaWYgKCF0aGlzLm9wdHMuYXBwICYmIHRoaXMub3B0cy5idW5kbGVJZCAmJiAhdGhpcy5zYWZhcmkpIHtcbiAgICAgIGlmICghYXdhaXQgdGhpcy5vcHRzLmRldmljZS5pc0FwcEluc3RhbGxlZCh0aGlzLm9wdHMuYnVuZGxlSWQpKSB7XG4gICAgICAgIGxvZy5lcnJvckFuZFRocm93KGBBcHAgd2l0aCBidW5kbGUgaWRlbnRpZmllciAnJHt0aGlzLm9wdHMuYnVuZGxlSWR9JyB1bmtub3duYCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0cy5wZXJtaXNzaW9ucykge1xuICAgICAgaWYgKHRoaXMuaXNTaW11bGF0b3IoKSkge1xuICAgICAgICBsb2cuZGVidWcoJ1NldHRpbmcgdGhlIHJlcXVlc3RlZCBwZXJtaXNzaW9ucyBiZWZvcmUgV0RBIGlzIHN0YXJ0ZWQnKTtcbiAgICAgICAgZm9yIChjb25zdCBbYnVuZGxlSWQsIHBlcm1pc3Npb25zTWFwcGluZ10gb2YgXy50b1BhaXJzKEpTT04ucGFyc2UodGhpcy5vcHRzLnBlcm1pc3Npb25zKSkpIHtcbiAgICAgICAgICBhd2FpdCB0aGlzLm9wdHMuZGV2aWNlLnNldFBlcm1pc3Npb25zKGJ1bmRsZUlkLCBwZXJtaXNzaW9uc01hcHBpbmcpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2cud2FybignU2V0dGluZyBwZXJtaXNzaW9ucyBpcyBvbmx5IHN1cHBvcnRlZCBvbiBTaW11bGF0b3IuICcgK1xuICAgICAgICAgICdUaGUgXCJwZXJtaXNzaW9uc1wiIGNhcGFiaWxpdHkgd2lsbCBiZSBpZ25vcmVkLicpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuc3RhcnRXZGEodGhpcy5vcHRzLnNlc3Npb25JZCwgcmVhbERldmljZSk7XG5cbiAgICBhd2FpdCB0aGlzLnNldFJlZHVjZU1vdGlvbih0aGlzLm9wdHMucmVkdWNlTW90aW9uKTtcblxuICAgIGF3YWl0IHRoaXMuc2V0SW5pdGlhbE9yaWVudGF0aW9uKHRoaXMub3B0cy5vcmllbnRhdGlvbik7XG4gICAgdGhpcy5sb2dFdmVudCgnb3JpZW50YXRpb25TZXQnKTtcblxuICAgIC8vIHJlYWwgZGV2aWNlcyB3aWxsIGJlIGhhbmRsZWQgbGF0ZXIsIGFmdGVyIHRoZSB3ZWIgY29udGV4dCBoYXMgYmVlbiBpbml0aWFsaXplZFxuICAgIGlmICh0aGlzLmlzU2FmYXJpKCkgJiYgIXRoaXMuaXNSZWFsRGV2aWNlKCkgJiYgdXRpbC5jb21wYXJlVmVyc2lvbnModGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbiwgJz49JywgJzEyLjInKSkge1xuICAgICAgLy8gb24gMTIuMiB0aGUgcGFnZSBpcyBub3Qgb3BlbmVkIGluIFdEQVxuICAgICAgYXdhaXQgb3BlblVybCh0aGlzLm9wdHMuZGV2aWNlLnVkaWQsIHRoaXMuX2N1cnJlbnRVcmwpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzU2FmYXJpKCkgfHwgdGhpcy5vcHRzLmF1dG9XZWJ2aWV3KSB7XG4gICAgICBsb2cuZGVidWcoJ1dhaXRpbmcgZm9yIGluaXRpYWwgd2VidmlldycpO1xuICAgICAgYXdhaXQgdGhpcy5uYXZUb0luaXRpYWxXZWJ2aWV3KCk7XG4gICAgICB0aGlzLmxvZ0V2ZW50KCdpbml0aWFsV2Vidmlld05hdmlnYXRlZCcpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmlzU2FmYXJpKCkgJiYgdGhpcy5pc1JlYWxEZXZpY2UoKSAmJiB1dGlsLmNvbXBhcmVWZXJzaW9ucyh0aGlzLm9wdHMucGxhdGZvcm1WZXJzaW9uLCAnPj0nLCAnMTIuMicpKSB7XG4gICAgICAvLyBvbiAxMi4yIHRoZSBwYWdlIGlzIG5vdCBvcGVuZWQgaW4gV0RBXG4gICAgICBhd2FpdCB0aGlzLnNldFVybCh0aGlzLl9jdXJyZW50VXJsKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuaXNSZWFsRGV2aWNlKCkpIHtcbiAgICAgIGlmICh0aGlzLm9wdHMuY2FsZW5kYXJBY2Nlc3NBdXRob3JpemVkKSB7XG4gICAgICAgIGF3YWl0IHRoaXMub3B0cy5kZXZpY2UuZW5hYmxlQ2FsZW5kYXJBY2Nlc3ModGhpcy5vcHRzLmJ1bmRsZUlkKTtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5vcHRzLmNhbGVuZGFyQWNjZXNzQXV0aG9yaXplZCA9PT0gZmFsc2UpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5vcHRzLmRldmljZS5kaXNhYmxlQ2FsZW5kYXJBY2Nlc3ModGhpcy5vcHRzLmJ1bmRsZUlkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU3RhcnQgV2ViRHJpdmVyQWdlbnRSdW5uZXJcbiAgICogQHBhcmFtIHtzdHJpbmd9IHNlc3Npb25JZCAtIFRoZSBpZCBvZiB0aGUgdGFyZ2V0IHNlc3Npb24gdG8gbGF1bmNoIFdEQSB3aXRoLlxuICAgKiBAcGFyYW0ge2Jvb2xlYW59IHJlYWxEZXZpY2UgLSBFcXVhbHMgdG8gdHJ1ZSBpZiB0aGUgdGVzdCB0YXJnZXQgZGV2aWNlIGlzIGEgcmVhbCBkZXZpY2UuXG4gICAqL1xuICBhc3luYyBzdGFydFdkYSAoc2Vzc2lvbklkLCByZWFsRGV2aWNlKSB7XG4gICAgdGhpcy53ZGEgPSBuZXcgV2ViRHJpdmVyQWdlbnQodGhpcy54Y29kZVZlcnNpb24sIHRoaXMub3B0cyk7XG5cbiAgICAvLyBEb24ndCBjbGVhbnVwIHRoZSBwcm9jZXNzZXMgaWYgd2ViRHJpdmVyQWdlbnRVcmwgaXMgc2V0XG4gICAgaWYgKCF1dGlsLmhhc1ZhbHVlKHRoaXMud2RhLndlYkRyaXZlckFnZW50VXJsKSkge1xuICAgICAgYXdhaXQgdGhpcy53ZGEuY2xlYW51cE9ic29sZXRlUHJvY2Vzc2VzKCk7XG4gICAgfVxuXG4gICAgY29uc3QgdXNlUG9ydEZvcndhcmRpbmcgPSB0aGlzLmlzUmVhbERldmljZSgpXG4gICAgICAmJiAhdGhpcy53ZGEud2ViRHJpdmVyQWdlbnRVcmxcbiAgICAgICYmIGlzTG9jYWxIb3N0KHRoaXMud2RhLndkYUJhc2VVcmwpO1xuICAgIGF3YWl0IERFVklDRV9DT05ORUNUSU9OU19GQUNUT1JZLnJlcXVlc3RDb25uZWN0aW9uKHRoaXMub3B0cy51ZGlkLCB0aGlzLndkYS51cmwucG9ydCwge1xuICAgICAgZGV2aWNlUG9ydDogdGhpcy53ZGEud2RhUmVtb3RlUG9ydCxcbiAgICAgIHVzZVBvcnRGb3J3YXJkaW5nLFxuICAgIH0pO1xuXG4gICAgLy8gTGV0IG11bHRpcGxlIFdEQSBiaW5hcmllcyB3aXRoIGRpZmZlcmVudCBkZXJpdmVkIGRhdGEgZm9sZGVycyBiZSBidWlsdCBpbiBwYXJhbGxlbFxuICAgIC8vIENvbmN1cnJlbnQgV0RBIGJ1aWxkcyBmcm9tIHRoZSBzYW1lIHNvdXJjZSB3aWxsIGNhdXNlIHhjb2RlYnVpbGQgc3luY2hyb25pemF0aW9uIGVycm9yc1xuICAgIGxldCBzeW5jaHJvbml6YXRpb25LZXkgPSBYQ1VJVGVzdERyaXZlci5uYW1lO1xuICAgIGlmICh0aGlzLm9wdHMudXNlWGN0ZXN0cnVuRmlsZSB8fCAhKGF3YWl0IHRoaXMud2RhLmlzU291cmNlRnJlc2goKSkpIHtcbiAgICAgIC8vIEZpcnN0LXRpbWUgY29tcGlsYXRpb24gaXMgYW4gZXhwZW5zaXZlIG9wZXJhdGlvbiwgd2hpY2ggaXMgZG9uZSBmYXN0ZXIgaWYgZXhlY3V0ZWRcbiAgICAgIC8vIHNlcXVlbnRpYWxseS4gWGNvZGVidWlsZCBzcHJlYWRzIHRoZSBsb2FkIGNhdXNlZCBieSB0aGUgY2xhbmcgY29tcGlsZXIgdG8gYWxsIGF2YWlsYWJsZSBDUFUgY29yZXNcbiAgICAgIGNvbnN0IGRlcml2ZWREYXRhUGF0aCA9IGF3YWl0IHRoaXMud2RhLnJldHJpZXZlRGVyaXZlZERhdGFQYXRoKCk7XG4gICAgICBpZiAoZGVyaXZlZERhdGFQYXRoKSB7XG4gICAgICAgIHN5bmNocm9uaXphdGlvbktleSA9IHBhdGgubm9ybWFsaXplKGRlcml2ZWREYXRhUGF0aCk7XG4gICAgICB9XG4gICAgfVxuICAgIGxvZy5kZWJ1ZyhgU3RhcnRpbmcgV2ViRHJpdmVyQWdlbnQgaW5pdGlhbGl6YXRpb24gd2l0aCB0aGUgc3luY2hyb25pemF0aW9uIGtleSAnJHtzeW5jaHJvbml6YXRpb25LZXl9J2ApO1xuICAgIGlmIChTSEFSRURfUkVTT1VSQ0VTX0dVQVJELmlzQnVzeSgpICYmICF0aGlzLm9wdHMuZGVyaXZlZERhdGFQYXRoICYmICF0aGlzLm9wdHMuYm9vdHN0cmFwUGF0aCkge1xuICAgICAgbG9nLmRlYnVnKGBDb25zaWRlciBzZXR0aW5nIGEgdW5pcXVlICdkZXJpdmVkRGF0YVBhdGgnIGNhcGFiaWxpdHkgdmFsdWUgZm9yIGVhY2ggcGFyYWxsZWwgZHJpdmVyIGluc3RhbmNlIGAgK1xuICAgICAgICBgdG8gYXZvaWQgY29uZmxpY3RzIGFuZCBzcGVlZCB1cCB0aGUgYnVpbGRpbmcgcHJvY2Vzc2ApO1xuICAgIH1cbiAgICByZXR1cm4gYXdhaXQgU0hBUkVEX1JFU09VUkNFU19HVUFSRC5hY3F1aXJlKHN5bmNocm9uaXphdGlvbktleSwgYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKHRoaXMub3B0cy51c2VOZXdXREEpIHtcbiAgICAgICAgbG9nLmRlYnVnKGBDYXBhYmlsaXR5ICd1c2VOZXdXREEnIHNldCB0byB0cnVlLCBzbyB1bmluc3RhbGxpbmcgV0RBIGJlZm9yZSBwcm9jZWVkaW5nYCk7XG4gICAgICAgIGF3YWl0IHRoaXMud2RhLnF1aXRBbmRVbmluc3RhbGwoKTtcbiAgICAgICAgdGhpcy5sb2dFdmVudCgnd2RhVW5pbnN0YWxsZWQnKTtcbiAgICAgIH0gZWxzZSBpZiAoIXV0aWwuaGFzVmFsdWUodGhpcy53ZGEud2ViRHJpdmVyQWdlbnRVcmwpKSB7XG4gICAgICAgIGF3YWl0IHRoaXMud2RhLnNldHVwQ2FjaGluZygpO1xuICAgICAgfVxuXG4gICAgICAvLyBsb2NhbCBoZWxwZXIgZm9yIHRoZSB0d28gcGxhY2VzIHdlIG5lZWQgdG8gdW5pbnN0YWxsIHdkYSBhbmQgcmUtc3RhcnQgaXRcbiAgICAgIGNvbnN0IHF1aXRBbmRVbmluc3RhbGwgPSBhc3luYyAobXNnKSA9PiB7XG4gICAgICAgIGxvZy5kZWJ1Zyhtc2cpO1xuICAgICAgICBpZiAodGhpcy5vcHRzLndlYkRyaXZlckFnZW50VXJsKSB7XG4gICAgICAgICAgbG9nLmRlYnVnKCdOb3QgcXVpdHRpbmcvdW5pbnN0YWxsaW5nIFdlYkRyaXZlckFnZW50IHNpbmNlIHdlYkRyaXZlckFnZW50VXJsIGNhcGFiaWxpdHkgaXMgcHJvdmlkZWQnKTtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobXNnKTtcbiAgICAgICAgfVxuICAgICAgICBsb2cud2FybignUXVpdHRpbmcgYW5kIHVuaW5zdGFsbGluZyBXZWJEcml2ZXJBZ2VudCcpO1xuICAgICAgICBhd2FpdCB0aGlzLndkYS5xdWl0QW5kVW5pbnN0YWxsKCk7XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgICB9O1xuXG4gICAgICBjb25zdCBzdGFydHVwUmV0cmllcyA9IHRoaXMub3B0cy53ZGFTdGFydHVwUmV0cmllcyB8fCAodGhpcy5pc1JlYWxEZXZpY2UoKSA/IFdEQV9SRUFMX0RFVl9TVEFSVFVQX1JFVFJJRVMgOiBXREFfU0lNX1NUQVJUVVBfUkVUUklFUyk7XG4gICAgICBjb25zdCBzdGFydHVwUmV0cnlJbnRlcnZhbCA9IHRoaXMub3B0cy53ZGFTdGFydHVwUmV0cnlJbnRlcnZhbCB8fCBXREFfU1RBUlRVUF9SRVRSWV9JTlRFUlZBTDtcbiAgICAgIGxvZy5kZWJ1ZyhgVHJ5aW5nIHRvIHN0YXJ0IFdlYkRyaXZlckFnZW50ICR7c3RhcnR1cFJldHJpZXN9IHRpbWVzIHdpdGggJHtzdGFydHVwUmV0cnlJbnRlcnZhbH1tcyBpbnRlcnZhbGApO1xuICAgICAgaWYgKCF1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy53ZGFTdGFydHVwUmV0cmllcykgJiYgIXV0aWwuaGFzVmFsdWUodGhpcy5vcHRzLndkYVN0YXJ0dXBSZXRyeUludGVydmFsKSkge1xuICAgICAgICBsb2cuZGVidWcoYFRoZXNlIHZhbHVlcyBjYW4gYmUgY3VzdG9taXplZCBieSBjaGFuZ2luZyB3ZGFTdGFydHVwUmV0cmllcy93ZGFTdGFydHVwUmV0cnlJbnRlcnZhbCBjYXBhYmlsaXRpZXNgKTtcbiAgICAgIH1cbiAgICAgIGxldCByZXRyeUNvdW50ID0gMDtcbiAgICAgIGF3YWl0IHJldHJ5SW50ZXJ2YWwoc3RhcnR1cFJldHJpZXMsIHN0YXJ0dXBSZXRyeUludGVydmFsLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIHRoaXMubG9nRXZlbnQoJ3dkYVN0YXJ0QXR0ZW1wdGVkJyk7XG4gICAgICAgIGlmIChyZXRyeUNvdW50ID4gMCkge1xuICAgICAgICAgIGxvZy5pbmZvKGBSZXRyeWluZyBXREEgc3RhcnR1cCAoJHtyZXRyeUNvdW50ICsgMX0gb2YgJHtzdGFydHVwUmV0cmllc30pYCk7XG4gICAgICAgIH1cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAvLyBvbiB4Y29kZSAxMCBpbnN0YWxsZCB3aWxsIG9mdGVuIHRyeSB0byBhY2Nlc3MgdGhlIGFwcCBmcm9tIGl0cyBzdGFnaW5nXG4gICAgICAgICAgLy8gZGlyZWN0b3J5IGJlZm9yZSBmdWxseSBtb3ZpbmcgaXQgdGhlcmUsIGFuZCBmYWlsLiBSZXRyeWluZyBvbmNlXG4gICAgICAgICAgLy8gaW1tZWRpYXRlbHkgaGVscHNcbiAgICAgICAgICBjb25zdCByZXRyaWVzID0gdGhpcy54Y29kZVZlcnNpb24ubWFqb3IgPj0gMTAgPyAyIDogMTtcbiAgICAgICAgICB0aGlzLmNhY2hlZFdkYVN0YXR1cyA9IGF3YWl0IHJldHJ5KHJldHJpZXMsIHRoaXMud2RhLmxhdW5jaC5iaW5kKHRoaXMud2RhKSwgc2Vzc2lvbklkLCByZWFsRGV2aWNlKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgdGhpcy5sb2dFdmVudCgnd2RhU3RhcnRGYWlsZWQnKTtcbiAgICAgICAgICByZXRyeUNvdW50Kys7XG4gICAgICAgICAgbGV0IGVycm9yTXNnID0gYFVuYWJsZSB0byBsYXVuY2ggV2ViRHJpdmVyQWdlbnQgYmVjYXVzZSBvZiB4Y29kZWJ1aWxkIGZhaWx1cmU6ICR7ZXJyLm1lc3NhZ2V9YDtcbiAgICAgICAgICBpZiAodGhpcy5pc1JlYWxEZXZpY2UoKSkge1xuICAgICAgICAgICAgZXJyb3JNc2cgKz0gYC4gTWFrZSBzdXJlIHlvdSBmb2xsb3cgdGhlIHR1dG9yaWFsIGF0ICR7V0RBX1JFQUxfREVWX1RVVE9SSUFMX1VSTH0uIGAgK1xuICAgICAgICAgICAgICAgICAgICAgICAgYFRyeSB0byByZW1vdmUgdGhlIFdlYkRyaXZlckFnZW50UnVubmVyIGFwcGxpY2F0aW9uIGZyb20gdGhlIGRldmljZSBpZiBpdCBpcyBpbnN0YWxsZWQgYCArXG4gICAgICAgICAgICAgICAgICAgICAgICBgYW5kIHJlYm9vdCB0aGUgZGV2aWNlLmA7XG4gICAgICAgICAgfVxuICAgICAgICAgIGF3YWl0IHF1aXRBbmRVbmluc3RhbGwoZXJyb3JNc2cpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5wcm94eVJlcVJlcyA9IHRoaXMud2RhLnByb3h5UmVxUmVzLmJpbmQodGhpcy53ZGEpO1xuICAgICAgICB0aGlzLmp3cFByb3h5QWN0aXZlID0gdHJ1ZTtcblxuICAgICAgICBsZXQgb3JpZ2luYWxTdGFja3RyYWNlID0gbnVsbDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCByZXRyeUludGVydmFsKDE1LCAxMDAwLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICB0aGlzLmxvZ0V2ZW50KCd3ZGFTZXNzaW9uQXR0ZW1wdGVkJyk7XG4gICAgICAgICAgICBsb2cuZGVidWcoJ1NlbmRpbmcgY3JlYXRlU2Vzc2lvbiBjb21tYW5kIHRvIFdEQScpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgdGhpcy5jYWNoZWRXZGFTdGF0dXMgPSB0aGlzLmNhY2hlZFdkYVN0YXR1cyB8fCBhd2FpdCB0aGlzLnByb3h5Q29tbWFuZCgnL3N0YXR1cycsICdHRVQnKTtcbiAgICAgICAgICAgICAgYXdhaXQgdGhpcy5zdGFydFdkYVNlc3Npb24odGhpcy5vcHRzLmJ1bmRsZUlkLCB0aGlzLm9wdHMucHJvY2Vzc0FyZ3VtZW50cyk7XG4gICAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgICAgb3JpZ2luYWxTdGFja3RyYWNlID0gZXJyLnN0YWNrO1xuICAgICAgICAgICAgICBsb2cuZGVidWcoYEZhaWxlZCB0byBjcmVhdGUgV0RBIHNlc3Npb24gKCR7ZXJyLm1lc3NhZ2V9KS4gUmV0cnlpbmcuLi5gKTtcbiAgICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHRoaXMubG9nRXZlbnQoJ3dkYVNlc3Npb25TdGFydGVkJyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGlmIChvcmlnaW5hbFN0YWNrdHJhY2UpIHtcbiAgICAgICAgICAgIGxvZy5kZWJ1ZyhvcmlnaW5hbFN0YWNrdHJhY2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBsZXQgZXJyb3JNc2cgPSBgVW5hYmxlIHRvIHN0YXJ0IFdlYkRyaXZlckFnZW50IHNlc3Npb24gYmVjYXVzZSBvZiB4Y29kZWJ1aWxkIGZhaWx1cmU6ICR7ZXJyLm1lc3NhZ2V9YDtcbiAgICAgICAgICBpZiAodGhpcy5pc1JlYWxEZXZpY2UoKSkge1xuICAgICAgICAgICAgZXJyb3JNc2cgKz0gYCBNYWtlIHN1cmUgeW91IGZvbGxvdyB0aGUgdHV0b3JpYWwgYXQgJHtXREFfUkVBTF9ERVZfVFVUT1JJQUxfVVJMfS4gYCArXG4gICAgICAgICAgICAgICAgICAgICAgICBgVHJ5IHRvIHJlbW92ZSB0aGUgV2ViRHJpdmVyQWdlbnRSdW5uZXIgYXBwbGljYXRpb24gZnJvbSB0aGUgZGV2aWNlIGlmIGl0IGlzIGluc3RhbGxlZCBgICtcbiAgICAgICAgICAgICAgICAgICAgICAgIGBhbmQgcmVib290IHRoZSBkZXZpY2UuYDtcbiAgICAgICAgICB9XG4gICAgICAgICAgYXdhaXQgcXVpdEFuZFVuaW5zdGFsbChlcnJvck1zZyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5vcHRzLmNsZWFyU3lzdGVtRmlsZXMgJiYgIXRoaXMub3B0cy53ZWJEcml2ZXJBZ2VudFVybCkge1xuICAgICAgICAgIGF3YWl0IG1hcmtTeXN0ZW1GaWxlc0ZvckNsZWFudXAodGhpcy53ZGEpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gd2UgZXhwZWN0IGNlcnRhaW4gc29ja2V0IGVycm9ycyB1bnRpbCB0aGlzIHBvaW50LCBidXQgbm93XG4gICAgICAgIC8vIG1hcmsgdGhpbmdzIGFzIGZ1bGx5IHdvcmtpbmdcbiAgICAgICAgdGhpcy53ZGEuZnVsbHlTdGFydGVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy5sb2dFdmVudCgnd2RhU3RhcnRlZCcpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBydW5SZXNldCAob3B0cyA9IG51bGwpIHtcbiAgICB0aGlzLmxvZ0V2ZW50KCdyZXNldFN0YXJ0ZWQnKTtcbiAgICBpZiAodGhpcy5pc1JlYWxEZXZpY2UoKSkge1xuICAgICAgYXdhaXQgcnVuUmVhbERldmljZVJlc2V0KHRoaXMub3B0cy5kZXZpY2UsIG9wdHMgfHwgdGhpcy5vcHRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYXdhaXQgcnVuU2ltdWxhdG9yUmVzZXQodGhpcy5vcHRzLmRldmljZSwgb3B0cyB8fCB0aGlzLm9wdHMpO1xuICAgIH1cbiAgICB0aGlzLmxvZ0V2ZW50KCdyZXNldENvbXBsZXRlJyk7XG4gIH1cblxuICBhc3luYyBkZWxldGVTZXNzaW9uICgpIHtcbiAgICBhd2FpdCByZW1vdmVBbGxTZXNzaW9uV2ViU29ja2V0SGFuZGxlcnModGhpcy5zZXJ2ZXIsIHRoaXMuc2Vzc2lvbklkKTtcblxuICAgIGlmICh0aGlzLmlzU2ltdWxhdG9yKCkgJiYgKHRoaXMub3B0cy5kZXZpY2UgfHwge30pLmlkYikge1xuICAgICAgYXdhaXQgdGhpcy5vcHRzLmRldmljZS5pZGIuZGlzY29ubmVjdCgpO1xuICAgICAgdGhpcy5vcHRzLmRldmljZS5pZGIgPSBudWxsO1xuICAgIH1cblxuICAgIGF3YWl0IHRoaXMuc3RvcCgpO1xuXG4gICAgaWYgKHRoaXMub3B0cy5jbGVhclN5c3RlbUZpbGVzICYmIHRoaXMuaXNBcHBUZW1wb3JhcnkpIHtcbiAgICAgIGF3YWl0IGZzLnJpbXJhZih0aGlzLm9wdHMuYXBwKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy53ZGEgJiYgIXRoaXMub3B0cy53ZWJEcml2ZXJBZ2VudFVybCkge1xuICAgICAgaWYgKHRoaXMub3B0cy5jbGVhclN5c3RlbUZpbGVzKSB7XG4gICAgICAgIGxldCBzeW5jaHJvbml6YXRpb25LZXkgPSBYQ1VJVGVzdERyaXZlci5uYW1lO1xuICAgICAgICBjb25zdCBkZXJpdmVkRGF0YVBhdGggPSBhd2FpdCB0aGlzLndkYS5yZXRyaWV2ZURlcml2ZWREYXRhUGF0aCgpO1xuICAgICAgICBpZiAoZGVyaXZlZERhdGFQYXRoKSB7XG4gICAgICAgICAgc3luY2hyb25pemF0aW9uS2V5ID0gcGF0aC5ub3JtYWxpemUoZGVyaXZlZERhdGFQYXRoKTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBTSEFSRURfUkVTT1VSQ0VTX0dVQVJELmFjcXVpcmUoc3luY2hyb25pemF0aW9uS2V5LCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgYXdhaXQgY2xlYXJTeXN0ZW1GaWxlcyh0aGlzLndkYSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nLmRlYnVnKCdOb3QgY2xlYXJpbmcgbG9nIGZpbGVzLiBVc2UgYGNsZWFyU3lzdGVtRmlsZXNgIGNhcGFiaWxpdHkgdG8gdHVybiBvbi4nKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5pc1dlYkNvbnRleHQoKSkge1xuICAgICAgbG9nLmRlYnVnKCdJbiBhIHdlYiBzZXNzaW9uLiBSZW1vdmluZyByZW1vdGUgZGVidWdnZXInKTtcbiAgICAgIGF3YWl0IHRoaXMuc3RvcFJlbW90ZSgpO1xuICAgIH1cblxuICAgIGlmICh0aGlzLm9wdHMucmVzZXRPblNlc3Npb25TdGFydE9ubHkgPT09IGZhbHNlKSB7XG4gICAgICBhd2FpdCB0aGlzLnJ1blJlc2V0KE9iamVjdC5hc3NpZ24oe30sIHRoaXMub3B0cywge1xuICAgICAgICBlbmZvcmNlU2ltdWxhdG9yU2h1dGRvd246IHRydWUsXG4gICAgICB9KSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaXNTaW11bGF0b3IoKSAmJiAhdGhpcy5vcHRzLm5vUmVzZXQgJiYgISF0aGlzLm9wdHMuZGV2aWNlKSB7XG4gICAgICBpZiAodGhpcy5saWZlY3ljbGVEYXRhLmNyZWF0ZVNpbSkge1xuICAgICAgICBsb2cuZGVidWcoYERlbGV0aW5nIHNpbXVsYXRvciBjcmVhdGVkIGZvciB0aGlzIHJ1biAodWRpZDogJyR7dGhpcy5vcHRzLnVkaWR9JylgKTtcbiAgICAgICAgYXdhaXQgc2h1dGRvd25TaW11bGF0b3IodGhpcy5vcHRzLmRldmljZSk7XG4gICAgICAgIGF3YWl0IHRoaXMub3B0cy5kZXZpY2UuZGVsZXRlKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFfLmlzRW1wdHkodGhpcy5sb2dzKSkge1xuICAgICAgYXdhaXQgdGhpcy5sb2dzLnN5c2xvZy5zdG9wQ2FwdHVyZSgpO1xuICAgICAgdGhpcy5sb2dzID0ge307XG4gICAgfVxuXG4gICAgaWYgKHRoaXMub3B0cy5lbmFibGVBc3luY0V4ZWN1dGVGcm9tSHR0cHMgJiYgIXRoaXMuaXNSZWFsRGV2aWNlKCkpIHtcbiAgICAgIGF3YWl0IHRoaXMuc3RvcEh0dHBzQXN5bmNTZXJ2ZXIoKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5tanBlZ1N0cmVhbSkge1xuICAgICAgbG9nLmluZm8oJ0Nsb3NpbmcgTUpQRUcgc3RyZWFtJyk7XG4gICAgICB0aGlzLm1qcGVnU3RyZWFtLnN0b3AoKTtcbiAgICB9XG5cbiAgICB0aGlzLnJlc2V0SW9zKCk7XG5cbiAgICBhd2FpdCBzdXBlci5kZWxldGVTZXNzaW9uKCk7XG4gIH1cblxuICBhc3luYyBzdG9wICgpIHtcbiAgICB0aGlzLmp3cFByb3h5QWN0aXZlID0gZmFsc2U7XG4gICAgdGhpcy5wcm94eVJlcVJlcyA9IG51bGw7XG5cblxuICAgIGlmICh0aGlzLndkYSAmJiB0aGlzLndkYS5mdWxseVN0YXJ0ZWQpIHtcbiAgICAgIGlmICh0aGlzLndkYS5qd3Byb3h5KSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdGhpcy5wcm94eUNvbW1hbmQoYC9zZXNzaW9uLyR7dGhpcy5zZXNzaW9uSWR9YCwgJ0RFTEVURScpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAvLyBhbiBlcnJvciBoZXJlIHNob3VsZCBub3Qgc2hvcnQtY2lyY3VpdCB0aGUgcmVzdCBvZiBjbGVhbiB1cFxuICAgICAgICAgIGxvZy5kZWJ1ZyhgVW5hYmxlIHRvIERFTEVURSBzZXNzaW9uIG9uIFdEQTogJyR7ZXJyLm1lc3NhZ2V9Jy4gQ29udGludWluZyBzaHV0ZG93bi5gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKCF0aGlzLndkYS53ZWJEcml2ZXJBZ2VudFVybCAmJiB0aGlzLm9wdHMudXNlTmV3V0RBKSB7XG4gICAgICAgIGF3YWl0IHRoaXMud2RhLnF1aXQoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBERVZJQ0VfQ09OTkVDVElPTlNfRkFDVE9SWS5yZWxlYXNlQ29ubmVjdGlvbih0aGlzLm9wdHMudWRpZCk7XG4gIH1cblxuICBhc3luYyBleGVjdXRlQ29tbWFuZCAoY21kLCAuLi5hcmdzKSB7XG4gICAgbG9nLmRlYnVnKGBFeGVjdXRpbmcgY29tbWFuZCAnJHtjbWR9J2ApO1xuXG4gICAgaWYgKGNtZCA9PT0gJ3JlY2VpdmVBc3luY1Jlc3BvbnNlJykge1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMucmVjZWl2ZUFzeW5jUmVzcG9uc2UoLi4uYXJncyk7XG4gICAgfVxuICAgIC8vIFRPRE86IG9uY2UgdGhpcyBmaXggZ2V0cyBpbnRvIGJhc2UgZHJpdmVyIHJlbW92ZSBmcm9tIGhlcmVcbiAgICBpZiAoY21kID09PSAnZ2V0U3RhdHVzJykge1xuICAgICAgcmV0dXJuIGF3YWl0IHRoaXMuZ2V0U3RhdHVzKCk7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBzdXBlci5leGVjdXRlQ29tbWFuZChjbWQsIC4uLmFyZ3MpO1xuICB9XG5cbiAgYXN5bmMgY29uZmlndXJlQXBwICgpIHtcbiAgICBmdW5jdGlvbiBhcHBJc1BhY2thZ2VPckJ1bmRsZSAoYXBwKSB7XG4gICAgICByZXR1cm4gKC9eKFthLXpBLVowLTlcXC1fXStcXC5bYS16QS1aMC05XFwtX10rKSskLykudGVzdChhcHApO1xuICAgIH1cblxuICAgIC8vIHRoZSBhcHAgbmFtZSBpcyBhIGJ1bmRsZUlkIGFzc2lnbiBpdCB0byB0aGUgYnVuZGxlSWQgcHJvcGVydHlcbiAgICBpZiAoIXRoaXMub3B0cy5idW5kbGVJZCAmJiBhcHBJc1BhY2thZ2VPckJ1bmRsZSh0aGlzLm9wdHMuYXBwKSkge1xuICAgICAgdGhpcy5vcHRzLmJ1bmRsZUlkID0gdGhpcy5vcHRzLmFwcDtcbiAgICAgIHRoaXMub3B0cy5hcHAgPSAnJztcbiAgICB9XG4gICAgLy8gd2UgaGF2ZSBhIGJ1bmRsZSBJRCwgYnV0IG5vIGFwcCwgb3IgYXBwIGlzIGFsc28gYSBidW5kbGVcbiAgICBpZiAoKHRoaXMub3B0cy5idW5kbGVJZCAmJiBhcHBJc1BhY2thZ2VPckJ1bmRsZSh0aGlzLm9wdHMuYnVuZGxlSWQpKSAmJlxuICAgICAgICAodGhpcy5vcHRzLmFwcCA9PT0gJycgfHwgYXBwSXNQYWNrYWdlT3JCdW5kbGUodGhpcy5vcHRzLmFwcCkpKSB7XG4gICAgICBsb2cuZGVidWcoJ0FwcCBpcyBhbiBpT1MgYnVuZGxlLCB3aWxsIGF0dGVtcHQgdG8gcnVuIGFzIHByZS1leGlzdGluZycpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIGNoZWNrIGZvciBzdXBwb3J0ZWQgYnVpbGQtaW4gYXBwc1xuICAgIGlmICh0aGlzLm9wdHMuYXBwICYmIHRoaXMub3B0cy5hcHAudG9Mb3dlckNhc2UoKSA9PT0gJ3NldHRpbmdzJykge1xuICAgICAgdGhpcy5vcHRzLmJ1bmRsZUlkID0gJ2NvbS5hcHBsZS5QcmVmZXJlbmNlcyc7XG4gICAgICB0aGlzLm9wdHMuYXBwID0gbnVsbDtcbiAgICAgIHJldHVybjtcbiAgICB9IGVsc2UgaWYgKHRoaXMub3B0cy5hcHAgJiYgdGhpcy5vcHRzLmFwcC50b0xvd2VyQ2FzZSgpID09PSAnY2FsZW5kYXInKSB7XG4gICAgICB0aGlzLm9wdHMuYnVuZGxlSWQgPSAnY29tLmFwcGxlLm1vYmlsZWNhbCc7XG4gICAgICB0aGlzLm9wdHMuYXBwID0gbnVsbDtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBvcmlnaW5hbEFwcFBhdGggPSB0aGlzLm9wdHMuYXBwO1xuICAgIHRyeSB7XG4gICAgICAvLyBkb3dubG9hZCBpZiBuZWNlc3NhcnlcbiAgICAgIHRoaXMub3B0cy5hcHAgPSBhd2FpdCB0aGlzLmhlbHBlcnMuY29uZmlndXJlQXBwKHRoaXMub3B0cy5hcHAsICcuYXBwJyk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsb2cuZXJyb3IoZXJyKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQmFkIGFwcDogJHt0aGlzLm9wdHMuYXBwfS4gQXBwIHBhdGhzIG5lZWQgdG8gYmUgYWJzb2x1dGUgb3IgYW4gVVJMIHRvIGEgY29tcHJlc3NlZCBhcHAgZmlsZSR7ZXJyICYmIGVyci5tZXNzYWdlID8gYDogJHtlcnIubWVzc2FnZX1gIDogJyd9YCk7XG4gICAgfVxuICAgIHRoaXMuaXNBcHBUZW1wb3JhcnkgPSB0aGlzLm9wdHMuYXBwICYmIGF3YWl0IGZzLmV4aXN0cyh0aGlzLm9wdHMuYXBwKVxuICAgICAgJiYgIWF3YWl0IHV0aWwuaXNTYW1lRGVzdGluYXRpb24ob3JpZ2luYWxBcHBQYXRoLCB0aGlzLm9wdHMuYXBwKTtcbiAgfVxuXG4gIGFzeW5jIGRldGVybWluZURldmljZSAoKSB7XG4gICAgLy8gaW4gdGhlIG9uZSBjYXNlIHdoZXJlIHdlIGNyZWF0ZSBhIHNpbSwgd2Ugd2lsbCBzZXQgdGhpcyBzdGF0ZVxuICAgIHRoaXMubGlmZWN5Y2xlRGF0YS5jcmVhdGVTaW0gPSBmYWxzZTtcblxuICAgIC8vIGlmIHdlIGdldCBnZW5lcmljIG5hbWVzLCB0cmFuc2xhdGUgdGhlbVxuICAgIHRoaXMub3B0cy5kZXZpY2VOYW1lID0gdHJhbnNsYXRlRGV2aWNlTmFtZSh0aGlzLm9wdHMucGxhdGZvcm1WZXJzaW9uLCB0aGlzLm9wdHMuZGV2aWNlTmFtZSk7XG5cbiAgICBjb25zdCBzZXR1cFZlcnNpb25DYXBzID0gYXN5bmMgKCkgPT4ge1xuICAgICAgdGhpcy5vcHRzLmlvc1Nka1ZlcnNpb24gPSBhd2FpdCBnZXRBbmRDaGVja0lvc1Nka1ZlcnNpb24oKTtcbiAgICAgIGxvZy5pbmZvKGBpT1MgU0RLIFZlcnNpb24gc2V0IHRvICcke3RoaXMub3B0cy5pb3NTZGtWZXJzaW9ufSdgKTtcbiAgICAgIGlmICghdGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbiAmJiB0aGlzLm9wdHMuaW9zU2RrVmVyc2lvbikge1xuICAgICAgICBsb2cuaW5mbyhgTm8gcGxhdGZvcm1WZXJzaW9uIHNwZWNpZmllZC4gVXNpbmcgdGhlIGxhdGVzdCB2ZXJzaW9uIFhjb2RlIHN1cHBvcnRzOiAnJHt0aGlzLm9wdHMuaW9zU2RrVmVyc2lvbn0nLiBgICtcbiAgICAgICAgICBgVGhpcyBtYXkgY2F1c2UgcHJvYmxlbXMgaWYgYSBzaW11bGF0b3IgZG9lcyBub3QgZXhpc3QgZm9yIHRoaXMgcGxhdGZvcm0gdmVyc2lvbi5gKTtcbiAgICAgICAgdGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbiA9IG5vcm1hbGl6ZVBsYXRmb3JtVmVyc2lvbih0aGlzLm9wdHMuaW9zU2RrVmVyc2lvbik7XG4gICAgICB9XG4gICAgfTtcblxuICAgIGlmICh0aGlzLm9wdHMudWRpZCkge1xuICAgICAgaWYgKHRoaXMub3B0cy51ZGlkLnRvTG93ZXJDYXNlKCkgPT09ICdhdXRvJykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHRoaXMub3B0cy51ZGlkID0gYXdhaXQgZGV0ZWN0VWRpZCgpO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAvLyBUcnlpbmcgdG8gZmluZCBtYXRjaGluZyBVRElEIGZvciBTaW11bGF0b3JcbiAgICAgICAgICBsb2cud2FybihgQ2Fubm90IGRldGVjdCBhbnkgY29ubmVjdGVkIHJlYWwgZGV2aWNlcy4gRmFsbGluZyBiYWNrIHRvIFNpbXVsYXRvci4gT3JpZ2luYWwgZXJyb3I6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgY29uc3QgZGV2aWNlID0gYXdhaXQgZ2V0RXhpc3RpbmdTaW0odGhpcy5vcHRzKTtcbiAgICAgICAgICBpZiAoIWRldmljZSkge1xuICAgICAgICAgICAgLy8gTm8gbWF0Y2hpbmcgU2ltdWxhdG9yIGlzIGZvdW5kLiBUaHJvdyBhbiBlcnJvclxuICAgICAgICAgICAgbG9nLmVycm9yQW5kVGhyb3coYENhbm5vdCBkZXRlY3QgdWRpZCBmb3IgJHt0aGlzLm9wdHMuZGV2aWNlTmFtZX0gU2ltdWxhdG9yIHJ1bm5pbmcgaU9TICR7dGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbn1gKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBNYXRjaGluZyBTaW11bGF0b3IgZXhpc3RzIGFuZCBpcyBmb3VuZC4gVXNlIGl0XG4gICAgICAgICAgdGhpcy5vcHRzLnVkaWQgPSBkZXZpY2UudWRpZDtcbiAgICAgICAgICBjb25zdCBkZXZpY2VQbGF0Zm9ybSA9IG5vcm1hbGl6ZVBsYXRmb3JtVmVyc2lvbihhd2FpdCBkZXZpY2UuZ2V0UGxhdGZvcm1WZXJzaW9uKCkpO1xuICAgICAgICAgIGlmICh0aGlzLm9wdHMucGxhdGZvcm1WZXJzaW9uICE9PSBkZXZpY2VQbGF0Zm9ybSkge1xuICAgICAgICAgICAgdGhpcy5vcHRzLnBsYXRmb3JtVmVyc2lvbiA9IGRldmljZVBsYXRmb3JtO1xuICAgICAgICAgICAgbG9nLmluZm8oYFNldCBwbGF0Zm9ybVZlcnNpb24gdG8gJyR7ZGV2aWNlUGxhdGZvcm19JyB0byBtYXRjaCB0aGUgZGV2aWNlIHdpdGggZ2l2ZW4gVURJRGApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBhd2FpdCBzZXR1cFZlcnNpb25DYXBzKCk7XG4gICAgICAgICAgcmV0dXJuIHtkZXZpY2UsIHJlYWxEZXZpY2U6IGZhbHNlLCB1ZGlkOiBkZXZpY2UudWRpZH07XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIG1ha2Ugc3VyZSBpdCBpcyBhIGNvbm5lY3RlZCBkZXZpY2UuIElmIG5vdCwgdGhlIHVkaWQgcGFzc2VkIGluIGlzIGludmFsaWRcbiAgICAgICAgY29uc3QgZGV2aWNlcyA9IGF3YWl0IGdldENvbm5lY3RlZERldmljZXMoKTtcbiAgICAgICAgbG9nLmRlYnVnKGBBdmFpbGFibGUgZGV2aWNlczogJHtkZXZpY2VzLmpvaW4oJywgJyl9YCk7XG4gICAgICAgIGlmICghZGV2aWNlcy5pbmNsdWRlcyh0aGlzLm9wdHMudWRpZCkpIHtcbiAgICAgICAgICAvLyBjaGVjayBmb3IgYSBwYXJ0aWN1bGFyIHNpbXVsYXRvclxuICAgICAgICAgIGlmIChhd2FpdCBzaW1FeGlzdHModGhpcy5vcHRzLnVkaWQpKSB7XG4gICAgICAgICAgICBjb25zdCBkZXZpY2UgPSBhd2FpdCBnZXRTaW11bGF0b3IodGhpcy5vcHRzLnVkaWQpO1xuICAgICAgICAgICAgcmV0dXJuIHtkZXZpY2UsIHJlYWxEZXZpY2U6IGZhbHNlLCB1ZGlkOiB0aGlzLm9wdHMudWRpZH07XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIGRldmljZSBvciBzaW11bGF0b3IgVURJRDogJyR7dGhpcy5vcHRzLnVkaWR9J2ApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGRldmljZSA9IGF3YWl0IGdldFJlYWxEZXZpY2VPYmoodGhpcy5vcHRzLnVkaWQpO1xuICAgICAgaWYgKF8uaXNFbXB0eSh0aGlzLm9wdHMucGxhdGZvcm1WZXJzaW9uKSkge1xuICAgICAgICBsb2cuaW5mbygnR2V0dGluZyB0aGUgcGxhdGZvcm1WZXJzaW9uIGZyb20gdGhlIHBob25lIHNpbmNlIGl0IHdhcyBub3Qgc3BlY2lmaWVkIGluIHRoZSBjYXBhYmlsaXRpZXMnKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBvc1ZlcnNpb24gPSBhd2FpdCBnZXRPU1ZlcnNpb24odGhpcy5vcHRzLnVkaWQpO1xuICAgICAgICAgIHRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24gPSB1dGlsLmNvZXJjZVZlcnNpb24ob3NWZXJzaW9uKTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGxvZy53YXJuKGBDYW5ub3QgZGV0ZXJtaW5lIHJlYWwgZGV2aWNlIHBsYXRmb3JtIHZlcnNpb24uIE9yaWdpbmFsIGVycm9yOiAke2UubWVzc2FnZX1gKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIHtkZXZpY2UsIHJlYWxEZXZpY2U6IHRydWUsIHVkaWQ6IHRoaXMub3B0cy51ZGlkfTtcbiAgICB9XG5cbiAgICAvLyBOb3cgd2Uga25vdyBmb3Igc3VyZSB0aGUgZGV2aWNlIHdpbGwgYmUgYSBTaW11bGF0b3JcbiAgICBhd2FpdCBzZXR1cFZlcnNpb25DYXBzKCk7XG4gICAgaWYgKHRoaXMub3B0cy5lbmZvcmNlRnJlc2hTaW11bGF0b3JDcmVhdGlvbikge1xuICAgICAgbG9nLmRlYnVnKGBOZXcgc2ltdWxhdG9yIGlzIHJlcXVlc3RlZC4gSWYgdGhpcyBpcyBub3Qgd2FudGVkLCBzZXQgJ2VuZm9yY2VGcmVzaFNpbXVsYXRvckNyZWF0aW9uJyBjYXBhYmlsaXR5IHRvIGZhbHNlYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIGZpZ3VyZSBvdXQgdGhlIGNvcnJlY3Qgc2ltdWxhdG9yIHRvIHVzZSwgZ2l2ZW4gdGhlIGRlc2lyZWQgY2FwYWJpbGl0aWVzXG4gICAgICBjb25zdCBkZXZpY2UgPSBhd2FpdCBnZXRFeGlzdGluZ1NpbSh0aGlzLm9wdHMpO1xuXG4gICAgICAvLyBjaGVjayBmb3IgYW4gZXhpc3Rpbmcgc2ltdWxhdG9yXG4gICAgICBpZiAoZGV2aWNlKSB7XG4gICAgICAgIHJldHVybiB7ZGV2aWNlLCByZWFsRGV2aWNlOiBmYWxzZSwgdWRpZDogZGV2aWNlLnVkaWR9O1xuICAgICAgfVxuXG4gICAgICBsb2cuaW5mbygnU2ltdWxhdG9yIHVkaWQgbm90IHByb3ZpZGVkJyk7XG4gICAgfVxuXG4gICAgLy8gbm8gZGV2aWNlIG9mIHRoaXMgdHlwZSBleGlzdHMsIG9yIHRoZXkgcmVxdWVzdCBuZXcgc2ltLCBzbyBjcmVhdGUgb25lXG4gICAgbG9nLmluZm8oJ1VzaW5nIGRlc2lyZWQgY2FwcyB0byBjcmVhdGUgYSBuZXcgc2ltdWxhdG9yJyk7XG4gICAgY29uc3QgZGV2aWNlID0gYXdhaXQgdGhpcy5jcmVhdGVTaW0oKTtcbiAgICByZXR1cm4ge2RldmljZSwgcmVhbERldmljZTogZmFsc2UsIHVkaWQ6IGRldmljZS51ZGlkfTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0U2ltICgpIHtcbiAgICBjb25zdCBydW5PcHRzID0ge1xuICAgICAgc2NhbGVGYWN0b3I6IHRoaXMub3B0cy5zY2FsZUZhY3RvcixcbiAgICAgIGNvbm5lY3RIYXJkd2FyZUtleWJvYXJkOiAhIXRoaXMub3B0cy5jb25uZWN0SGFyZHdhcmVLZXlib2FyZCxcbiAgICAgIGlzSGVhZGxlc3M6ICEhdGhpcy5vcHRzLmlzSGVhZGxlc3MsXG4gICAgICBkZXZpY2VQcmVmZXJlbmNlczoge30sXG4gICAgfTtcblxuICAgIC8vIGFkZCB0aGUgd2luZG93IGNlbnRlciwgaWYgaXQgaXMgc3BlY2lmaWVkXG4gICAgaWYgKHRoaXMub3B0cy5TaW11bGF0b3JXaW5kb3dDZW50ZXIpIHtcbiAgICAgIHJ1bk9wdHMuZGV2aWNlUHJlZmVyZW5jZXMuU2ltdWxhdG9yV2luZG93Q2VudGVyID0gdGhpcy5vcHRzLlNpbXVsYXRvcldpbmRvd0NlbnRlcjtcbiAgICB9XG5cbiAgICAvLyBUaGlzIGlzIHRvIHdvcmthcm91bmQgWENUZXN0IGJ1ZyBhYm91dCBjaGFuZ2luZyBTaW11bGF0b3JcbiAgICAvLyBvcmllbnRhdGlvbiBpcyBub3Qgc3luY2hyb25pemVkIHRvIHRoZSBhY3R1YWwgd2luZG93IG9yaWVudGF0aW9uXG4gICAgY29uc3Qgb3JpZW50YXRpb24gPSBfLmlzU3RyaW5nKHRoaXMub3B0cy5vcmllbnRhdGlvbikgJiYgdGhpcy5vcHRzLm9yaWVudGF0aW9uLnRvVXBwZXJDYXNlKCk7XG4gICAgc3dpdGNoIChvcmllbnRhdGlvbikge1xuICAgICAgY2FzZSAnTEFORFNDQVBFJzpcbiAgICAgICAgcnVuT3B0cy5kZXZpY2VQcmVmZXJlbmNlcy5TaW11bGF0b3JXaW5kb3dPcmllbnRhdGlvbiA9ICdMYW5kc2NhcGVMZWZ0JztcbiAgICAgICAgcnVuT3B0cy5kZXZpY2VQcmVmZXJlbmNlcy5TaW11bGF0b3JXaW5kb3dSb3RhdGlvbkFuZ2xlID0gOTA7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUE9SVFJBSVQnOlxuICAgICAgICBydW5PcHRzLmRldmljZVByZWZlcmVuY2VzLlNpbXVsYXRvcldpbmRvd09yaWVudGF0aW9uID0gJ1BvcnRyYWl0JztcbiAgICAgICAgcnVuT3B0cy5kZXZpY2VQcmVmZXJlbmNlcy5TaW11bGF0b3JXaW5kb3dSb3RhdGlvbkFuZ2xlID0gMDtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5vcHRzLmRldmljZS5ydW4ocnVuT3B0cyk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVTaW0gKCkge1xuICAgIHRoaXMubGlmZWN5Y2xlRGF0YS5jcmVhdGVTaW0gPSB0cnVlO1xuXG4gICAgLy8gR2V0IHBsYXRmb3JtIG5hbWUgZnJvbSBjb25zdCBzaW5jZSBpdCBtdXN0IGJlIGNhc2Ugc2Vuc2l0aXZlIHRvIGNyZWF0ZSBhIG5ldyBzaW11bGF0b3JcbiAgICBjb25zdCBwbGF0Zm9ybU5hbWUgPSBpc1R2T1ModGhpcy5vcHRzLnBsYXRmb3JtTmFtZSkgPyBQTEFURk9STV9OQU1FX1RWT1MgOiBQTEFURk9STV9OQU1FX0lPUztcblxuICAgIC8vIGNyZWF0ZSBzaW0gZm9yIGNhcHNcbiAgICBsZXQgc2ltID0gYXdhaXQgY3JlYXRlU2ltKHRoaXMub3B0cywgcGxhdGZvcm1OYW1lKTtcbiAgICBsb2cuaW5mbyhgQ3JlYXRlZCBzaW11bGF0b3Igd2l0aCB1ZGlkICcke3NpbS51ZGlkfScuYCk7XG5cbiAgICByZXR1cm4gc2ltO1xuICB9XG5cbiAgYXN5bmMgbGF1bmNoQXBwICgpIHtcbiAgICBjb25zdCBBUFBfTEFVTkNIX1RJTUVPVVQgPSAyMCAqIDEwMDA7XG5cbiAgICB0aGlzLmxvZ0V2ZW50KCdhcHBMYXVuY2hBdHRlbXB0ZWQnKTtcbiAgICBhd2FpdCBsYXVuY2godGhpcy5vcHRzLmRldmljZS51ZGlkLCB0aGlzLm9wdHMuYnVuZGxlSWQpO1xuXG4gICAgbGV0IGNoZWNrU3RhdHVzID0gYXN5bmMgKCkgPT4ge1xuICAgICAgbGV0IHJlc3BvbnNlID0gYXdhaXQgdGhpcy5wcm94eUNvbW1hbmQoJy9zdGF0dXMnLCAnR0VUJyk7XG4gICAgICBsZXQgY3VycmVudEFwcCA9IHJlc3BvbnNlLmN1cnJlbnRBcHAuYnVuZGxlSUQ7XG4gICAgICBpZiAoY3VycmVudEFwcCAhPT0gdGhpcy5vcHRzLmJ1bmRsZUlkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgJHt0aGlzLm9wdHMuYnVuZGxlSWR9IG5vdCBpbiBmb3JlZ3JvdW5kLiAke2N1cnJlbnRBcHB9IGlzIGluIGZvcmVncm91bmRgKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgbG9nLmluZm8oYFdhaXRpbmcgZm9yICcke3RoaXMub3B0cy5idW5kbGVJZH0nIHRvIGJlIGluIGZvcmVncm91bmRgKTtcbiAgICBsZXQgcmV0cmllcyA9IHBhcnNlSW50KEFQUF9MQVVOQ0hfVElNRU9VVCAvIDIwMCwgMTApO1xuICAgIGF3YWl0IHJldHJ5SW50ZXJ2YWwocmV0cmllcywgMjAwLCBjaGVja1N0YXR1cyk7XG4gICAgbG9nLmluZm8oYCR7dGhpcy5vcHRzLmJ1bmRsZUlkfSBpcyBpbiBmb3JlZ3JvdW5kYCk7XG4gICAgdGhpcy5sb2dFdmVudCgnYXBwTGF1bmNoZWQnKTtcbiAgfVxuXG4gIGFzeW5jIHN0YXJ0V2RhU2Vzc2lvbiAoYnVuZGxlSWQsIHByb2Nlc3NBcmd1bWVudHMpIHtcbiAgICBsZXQgYXJncyA9IHByb2Nlc3NBcmd1bWVudHMgPyAocHJvY2Vzc0FyZ3VtZW50cy5hcmdzIHx8IFtdKSA6IFtdO1xuICAgIGlmICghXy5pc0FycmF5KGFyZ3MpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHByb2Nlc3NBcmd1bWVudHMuYXJncyBjYXBhYmlsaXR5IGlzIGV4cGVjdGVkIHRvIGJlIGFuIGFycmF5LiBgICtcbiAgICAgICAgICAgICAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeShhcmdzKX0gaXMgZ2l2ZW4gaW5zdGVhZGApO1xuICAgIH1cbiAgICBsZXQgZW52ID0gcHJvY2Vzc0FyZ3VtZW50cyA/IChwcm9jZXNzQXJndW1lbnRzLmVudiB8fCB7fSkgOiB7fTtcbiAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChlbnYpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHByb2Nlc3NBcmd1bWVudHMuZW52IGNhcGFiaWxpdHkgaXMgZXhwZWN0ZWQgdG8gYmUgYSBkaWN0aW9uYXJ5LiBgICtcbiAgICAgICAgICAgICAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeShlbnYpfSBpcyBnaXZlbiBpbnN0ZWFkYCk7XG4gICAgfVxuXG4gICAgbGV0IHNob3VsZFdhaXRGb3JRdWllc2NlbmNlID0gdXRpbC5oYXNWYWx1ZSh0aGlzLm9wdHMud2FpdEZvclF1aWVzY2VuY2UpID8gdGhpcy5vcHRzLndhaXRGb3JRdWllc2NlbmNlIDogdHJ1ZTtcbiAgICBsZXQgbWF4VHlwaW5nRnJlcXVlbmN5ID0gdXRpbC5oYXNWYWx1ZSh0aGlzLm9wdHMubWF4VHlwaW5nRnJlcXVlbmN5KSA/IHRoaXMub3B0cy5tYXhUeXBpbmdGcmVxdWVuY3kgOiA2MDtcbiAgICBsZXQgc2hvdWxkVXNlU2luZ2xldG9uVGVzdE1hbmFnZXIgPSB1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy5zaG91bGRVc2VTaW5nbGV0b25UZXN0TWFuYWdlcikgPyB0aGlzLm9wdHMuc2hvdWxkVXNlU2luZ2xldG9uVGVzdE1hbmFnZXIgOiB0cnVlO1xuICAgIGxldCBzaG91bGRVc2VUZXN0TWFuYWdlckZvclZpc2liaWxpdHlEZXRlY3Rpb24gPSBmYWxzZTtcbiAgICBsZXQgZXZlbnRsb29wSWRsZURlbGF5U2VjID0gdGhpcy5vcHRzLndkYUV2ZW50bG9vcElkbGVEZWxheSB8fCAwO1xuICAgIGlmICh1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy5zaW1wbGVJc1Zpc2libGVDaGVjaykpIHtcbiAgICAgIHNob3VsZFVzZVRlc3RNYW5hZ2VyRm9yVmlzaWJpbGl0eURldGVjdGlvbiA9IHRoaXMub3B0cy5zaW1wbGVJc1Zpc2libGVDaGVjaztcbiAgICB9XG4gICAgaWYgKHV0aWwuY29tcGFyZVZlcnNpb25zKHRoaXMub3B0cy5wbGF0Zm9ybVZlcnNpb24sICc9PScsICc5LjMnKSkge1xuICAgICAgbG9nLmluZm8oYEZvcmNpbmcgc2hvdWxkVXNlU2luZ2xldG9uVGVzdE1hbmFnZXIgY2FwYWJpbGl0eSB2YWx1ZSB0byB0cnVlLCBiZWNhdXNlIG9mIGtub3duIFhDVGVzdCBpc3N1ZXMgdW5kZXIgOS4zIHBsYXRmb3JtIHZlcnNpb25gKTtcbiAgICAgIHNob3VsZFVzZVRlc3RNYW5hZ2VyRm9yVmlzaWJpbGl0eURldGVjdGlvbiA9IHRydWU7XG4gICAgfVxuICAgIGlmICh1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy5sYW5ndWFnZSkpIHtcbiAgICAgIGFyZ3MucHVzaCgnLUFwcGxlTGFuZ3VhZ2VzJywgYCgke3RoaXMub3B0cy5sYW5ndWFnZX0pYCk7XG4gICAgICBhcmdzLnB1c2goJy1OU0xhbmd1YWdlcycsIGAoJHt0aGlzLm9wdHMubGFuZ3VhZ2V9KWApO1xuICAgIH1cblxuICAgIGlmICh1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy5sb2NhbGUpKSB7XG4gICAgICBhcmdzLnB1c2goJy1BcHBsZUxvY2FsZScsIHRoaXMub3B0cy5sb2NhbGUpO1xuICAgIH1cblxuICAgIGNvbnN0IHdkYUNhcHMgPSB7XG4gICAgICBidW5kbGVJZDogdGhpcy5vcHRzLmF1dG9MYXVuY2ggPT09IGZhbHNlID8gdW5kZWZpbmVkIDogYnVuZGxlSWQsXG4gICAgICBhcmd1bWVudHM6IGFyZ3MsXG4gICAgICBlbnZpcm9ubWVudDogZW52LFxuICAgICAgZXZlbnRsb29wSWRsZURlbGF5U2VjLFxuICAgICAgc2hvdWxkV2FpdEZvclF1aWVzY2VuY2UsXG4gICAgICBzaG91bGRVc2VUZXN0TWFuYWdlckZvclZpc2liaWxpdHlEZXRlY3Rpb24sXG4gICAgICBtYXhUeXBpbmdGcmVxdWVuY3ksXG4gICAgICBzaG91bGRVc2VTaW5nbGV0b25UZXN0TWFuYWdlcixcbiAgICB9O1xuICAgIGlmICh1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy5zaG91bGRVc2VDb21wYWN0UmVzcG9uc2VzKSkge1xuICAgICAgd2RhQ2Fwcy5zaG91bGRVc2VDb21wYWN0UmVzcG9uc2VzID0gdGhpcy5vcHRzLnNob3VsZFVzZUNvbXBhY3RSZXNwb25zZXM7XG4gICAgfVxuICAgIGlmICh1dGlsLmhhc1ZhbHVlKHRoaXMub3B0cy5lbGVtZW50UmVzcG9uc2VGaWVsZHMpKSB7XG4gICAgICB3ZGFDYXBzLmVsZW1lbnRSZXNwb25zZUZpZWxkcyA9IHRoaXMub3B0cy5lbGVtZW50UmVzcG9uc2VGaWVsZHM7XG4gICAgfVxuICAgIGlmICh0aGlzLm9wdHMuYXV0b0FjY2VwdEFsZXJ0cykge1xuICAgICAgd2RhQ2Fwcy5kZWZhdWx0QWxlcnRBY3Rpb24gPSAnYWNjZXB0JztcbiAgICB9IGVsc2UgaWYgKHRoaXMub3B0cy5hdXRvRGlzbWlzc0FsZXJ0cykge1xuICAgICAgd2RhQ2Fwcy5kZWZhdWx0QWxlcnRBY3Rpb24gPSAnZGlzbWlzcyc7XG4gICAgfVxuXG4gICAgYXdhaXQgdGhpcy5wcm94eUNvbW1hbmQoJy9zZXNzaW9uJywgJ1BPU1QnLCB7XG4gICAgICBjYXBhYmlsaXRpZXM6IHtcbiAgICAgICAgZmlyc3RNYXRjaDogW3dkYUNhcHNdLFxuICAgICAgICBhbHdheXNNYXRjaDoge30sXG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBPdmVycmlkZSBQcm94eSBtZXRob2RzIGZyb20gQmFzZURyaXZlclxuICBwcm94eUFjdGl2ZSAoKSB7XG4gICAgcmV0dXJuIHRoaXMuandwUHJveHlBY3RpdmU7XG4gIH1cblxuICBnZXRQcm94eUF2b2lkTGlzdCAoKSB7XG4gICAgaWYgKHRoaXMuaXNXZWJ2aWV3KCkpIHtcbiAgICAgIHJldHVybiBOT19QUk9YWV9XRUJfTElTVDtcbiAgICB9XG4gICAgcmV0dXJuIE5PX1BST1hZX05BVElWRV9MSVNUO1xuICB9XG5cbiAgY2FuUHJveHkgKCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaXNTYWZhcmkgKCkge1xuICAgIHJldHVybiAhIXRoaXMuc2FmYXJpO1xuICB9XG5cbiAgaXNSZWFsRGV2aWNlICgpIHtcbiAgICByZXR1cm4gdGhpcy5vcHRzLnJlYWxEZXZpY2U7XG4gIH1cblxuICBpc1NpbXVsYXRvciAoKSB7XG4gICAgcmV0dXJuICF0aGlzLm9wdHMucmVhbERldmljZTtcbiAgfVxuXG4gIGlzV2VidmlldyAoKSB7XG4gICAgcmV0dXJuIHRoaXMuaXNTYWZhcmkoKSB8fCB0aGlzLmlzV2ViQ29udGV4dCgpO1xuICB9XG5cbiAgdmFsaWRhdGVMb2NhdG9yU3RyYXRlZ3kgKHN0cmF0ZWd5KSB7XG4gICAgc3VwZXIudmFsaWRhdGVMb2NhdG9yU3RyYXRlZ3koc3RyYXRlZ3ksIHRoaXMuaXNXZWJDb250ZXh0KCkpO1xuICB9XG5cbiAgdmFsaWRhdGVEZXNpcmVkQ2FwcyAoY2Fwcykge1xuICAgIGlmICghc3VwZXIudmFsaWRhdGVEZXNpcmVkQ2FwcyhjYXBzKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIG1ha2Ugc3VyZSB0aGF0IHRoZSBjYXBhYmlsaXRpZXMgaGF2ZSBvbmUgb2YgYGFwcGAgb3IgYGJ1bmRsZUlkYFxuICAgIGlmICgoY2Fwcy5icm93c2VyTmFtZSB8fCAnJykudG9Mb3dlckNhc2UoKSAhPT0gJ3NhZmFyaScgJiYgIWNhcHMuYXBwICYmICFjYXBzLmJ1bmRsZUlkKSB7XG4gICAgICBsZXQgbXNnID0gJ1RoZSBkZXNpcmVkIGNhcGFiaWxpdGllcyBtdXN0IGluY2x1ZGUgZWl0aGVyIGFuIGFwcCBvciBhIGJ1bmRsZUlkIGZvciBpT1MnO1xuICAgICAgbG9nLmVycm9yQW5kVGhyb3cobXNnKTtcbiAgICB9XG5cbiAgICBpZiAoIXV0aWwuY29lcmNlVmVyc2lvbihjYXBzLnBsYXRmb3JtVmVyc2lvbiwgZmFsc2UpKSB7XG4gICAgICBsb2cud2FybihgJ3BsYXRmb3JtVmVyc2lvbicgY2FwYWJpbGl0eSAoJyR7Y2Fwcy5wbGF0Zm9ybVZlcnNpb259JykgaXMgbm90IGEgdmFsaWQgdmVyc2lvbiBudW1iZXIuIGAgK1xuICAgICAgICBgQ29uc2lkZXIgZml4aW5nIGl0IG9yIGJlIHJlYWR5IHRvIGV4cGVyaWVuY2UgYW4gaW5jb25zaXN0ZW50IGRyaXZlciBiZWhhdmlvci5gKTtcbiAgICB9XG5cbiAgICBsZXQgdmVyaWZ5UHJvY2Vzc0FyZ3VtZW50ID0gKHByb2Nlc3NBcmd1bWVudHMpID0+IHtcbiAgICAgIGNvbnN0IHthcmdzLCBlbnZ9ID0gcHJvY2Vzc0FyZ3VtZW50cztcbiAgICAgIGlmICghXy5pc05pbChhcmdzKSAmJiAhXy5pc0FycmF5KGFyZ3MpKSB7XG4gICAgICAgIGxvZy5lcnJvckFuZFRocm93KCdwcm9jZXNzQXJndW1lbnRzLmFyZ3MgbXVzdCBiZSBhbiBhcnJheSBvZiBzdHJpbmdzJyk7XG4gICAgICB9XG4gICAgICBpZiAoIV8uaXNOaWwoZW52KSAmJiAhXy5pc1BsYWluT2JqZWN0KGVudikpIHtcbiAgICAgICAgbG9nLmVycm9yQW5kVGhyb3coJ3Byb2Nlc3NBcmd1bWVudHMuZW52IG11c3QgYmUgYW4gb2JqZWN0IDxrZXksdmFsdWU+IHBhaXIge2E6YiwgYzpkfScpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICAvLyBgcHJvY2Vzc0FyZ3VtZW50c2Agc2hvdWxkIGJlIEpTT04gc3RyaW5nIG9yIGFuIG9iamVjdCB3aXRoIGFyZ3VtZW50cyBhbmQvIGVudmlyb25tZW50IGRldGFpbHNcbiAgICBpZiAoY2Fwcy5wcm9jZXNzQXJndW1lbnRzKSB7XG4gICAgICBpZiAoXy5pc1N0cmluZyhjYXBzLnByb2Nlc3NBcmd1bWVudHMpKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgLy8gdHJ5IHRvIHBhcnNlIHRoZSBzdHJpbmcgYXMgSlNPTlxuICAgICAgICAgIGNhcHMucHJvY2Vzc0FyZ3VtZW50cyA9IEpTT04ucGFyc2UoY2Fwcy5wcm9jZXNzQXJndW1lbnRzKTtcbiAgICAgICAgICB2ZXJpZnlQcm9jZXNzQXJndW1lbnQoY2Fwcy5wcm9jZXNzQXJndW1lbnRzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgbG9nLmVycm9yQW5kVGhyb3coYHByb2Nlc3NBcmd1bWVudHMgbXVzdCBiZSBhIGpzb24gZm9ybWF0IG9yIGFuIG9iamVjdCB3aXRoIGZvcm1hdCB7YXJncyA6IFtdLCBlbnYgOiB7YTpiLCBjOmR9fS4gYCArXG4gICAgICAgICAgICBgQm90aCBlbnZpcm9ubWVudCBhbmQgYXJndW1lbnQgY2FuIGJlIG51bGwuIEVycm9yOiAke2Vycn1gKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChfLmlzUGxhaW5PYmplY3QoY2Fwcy5wcm9jZXNzQXJndW1lbnRzKSkge1xuICAgICAgICB2ZXJpZnlQcm9jZXNzQXJndW1lbnQoY2Fwcy5wcm9jZXNzQXJndW1lbnRzKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZy5lcnJvckFuZFRocm93KGAncHJvY2Vzc0FyZ3VtZW50cyBtdXN0IGJlIGFuIG9iamVjdCwgb3IgYSBzdHJpbmcgSlNPTiBvYmplY3Qgd2l0aCBmb3JtYXQge2FyZ3MgOiBbXSwgZW52IDoge2E6YiwgYzpkfX0uIGAgK1xuICAgICAgICAgIGBCb3RoIGVudmlyb25tZW50IGFuZCBhcmd1bWVudCBjYW4gYmUgbnVsbC5gKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyB0aGVyZSBpcyBubyBwb2ludCBpbiBoYXZpbmcgYGtleWNoYWluUGF0aGAgd2l0aG91dCBga2V5Y2hhaW5QYXNzd29yZGBcbiAgICBpZiAoKGNhcHMua2V5Y2hhaW5QYXRoICYmICFjYXBzLmtleWNoYWluUGFzc3dvcmQpIHx8ICghY2Fwcy5rZXljaGFpblBhdGggJiYgY2Fwcy5rZXljaGFpblBhc3N3b3JkKSkge1xuICAgICAgbG9nLmVycm9yQW5kVGhyb3coYElmICdrZXljaGFpblBhdGgnIGlzIHNldCwgJ2tleWNoYWluUGFzc3dvcmQnIG11c3QgYWxzbyBiZSBzZXQgKGFuZCB2aWNlIHZlcnNhKS5gKTtcbiAgICB9XG5cbiAgICAvLyBgcmVzZXRPblNlc3Npb25TdGFydE9ubHlgIHNob3VsZCBiZSBzZXQgdG8gdHJ1ZSBieSBkZWZhdWx0XG4gICAgdGhpcy5vcHRzLnJlc2V0T25TZXNzaW9uU3RhcnRPbmx5ID0gIXV0aWwuaGFzVmFsdWUodGhpcy5vcHRzLnJlc2V0T25TZXNzaW9uU3RhcnRPbmx5KSB8fCB0aGlzLm9wdHMucmVzZXRPblNlc3Npb25TdGFydE9ubHk7XG4gICAgdGhpcy5vcHRzLnVzZU5ld1dEQSA9IHV0aWwuaGFzVmFsdWUodGhpcy5vcHRzLnVzZU5ld1dEQSkgPyB0aGlzLm9wdHMudXNlTmV3V0RBIDogZmFsc2U7XG5cbiAgICBpZiAoY2Fwcy5jb21tYW5kVGltZW91dHMpIHtcbiAgICAgIGNhcHMuY29tbWFuZFRpbWVvdXRzID0gbm9ybWFsaXplQ29tbWFuZFRpbWVvdXRzKGNhcHMuY29tbWFuZFRpbWVvdXRzKTtcbiAgICB9XG5cbiAgICBpZiAoXy5pc1N0cmluZyhjYXBzLndlYkRyaXZlckFnZW50VXJsKSkge1xuICAgICAgY29uc3Qge3Byb3RvY29sLCBob3N0fSA9IHVybC5wYXJzZShjYXBzLndlYkRyaXZlckFnZW50VXJsKTtcbiAgICAgIGlmIChfLmlzRW1wdHkocHJvdG9jb2wpIHx8IF8uaXNFbXB0eShob3N0KSkge1xuICAgICAgICBsb2cuZXJyb3JBbmRUaHJvdyhgJ3dlYkRyaXZlckFnZW50VXJsJyBjYXBhYmlsaXR5IGlzIGV4cGVjdGVkIHRvIGNvbnRhaW4gYSB2YWxpZCBXZWJEcml2ZXJBZ2VudCBzZXJ2ZXIgVVJMLiBgICtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgYCcke2NhcHMud2ViRHJpdmVyQWdlbnRVcmx9JyBpcyBnaXZlbiBpbnN0ZWFkYCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGNhcHMuYnJvd3Nlck5hbWUpIHtcbiAgICAgIGlmIChjYXBzLmJ1bmRsZUlkKSB7XG4gICAgICAgIGxvZy5lcnJvckFuZFRocm93KGAnYnJvd3Nlck5hbWUnIGNhbm5vdCBiZSBzZXQgdG9nZXRoZXIgd2l0aCAnYnVuZGxlSWQnIGNhcGFiaWxpdHlgKTtcbiAgICAgIH1cbiAgICAgIC8vIHdhcm4gaWYgdGhlIGNhcGFiaWxpdGllcyBoYXZlIGJvdGggYGFwcGAgYW5kIGBicm93c2VyLCBhbHRob3VnaCB0aGlzXG4gICAgICAvLyBpcyBjb21tb24gd2l0aCBzZWxlbml1bSBncmlkXG4gICAgICBpZiAoY2Fwcy5hcHApIHtcbiAgICAgICAgbG9nLndhcm4oYFRoZSBjYXBhYmlsaXRpZXMgc2hvdWxkIGdlbmVyYWxseSBub3QgaW5jbHVkZSBib3RoIGFuICdhcHAnIGFuZCBhICdicm93c2VyTmFtZSdgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoY2Fwcy5wZXJtaXNzaW9ucykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgZm9yIChjb25zdCBbYnVuZGxlSWQsIHBlcm1zXSBvZiBfLnRvUGFpcnMoSlNPTi5wYXJzZShjYXBzLnBlcm1pc3Npb25zKSkpIHtcbiAgICAgICAgICBpZiAoIV8uaXNTdHJpbmcoYnVuZGxlSWQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYCcke0pTT04uc3RyaW5naWZ5KGJ1bmRsZUlkKX0nIG11c3QgYmUgYSBzdHJpbmdgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocGVybXMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYCcke0pTT04uc3RyaW5naWZ5KHBlcm1zKX0nIG11c3QgYmUgYSBKU09OIG9iamVjdGApO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2cuZXJyb3JBbmRUaHJvdyhgJyR7Y2Fwcy5wZXJtaXNzaW9uc30nIGlzIGV4cGVjdGVkIHRvIGJlIGEgdmFsaWQgb2JqZWN0IHdpdGggZm9ybWF0IGAgK1xuICAgICAgICAgIGB7XCI8YnVuZGxlSWQxPlwiOiB7XCI8c2VydmljZU5hbWUxPlwiOiBcIjxzZXJ2aWNlU3RhdHVzMT5cIiwgLi4ufSwgLi4ufS4gT3JpZ2luYWwgZXJyb3I6ICR7ZS5tZXNzYWdlfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChjYXBzLnBsYXRmb3JtVmVyc2lvbiAmJiAhdXRpbC5jb2VyY2VWZXJzaW9uKGNhcHMucGxhdGZvcm1WZXJzaW9uLCBmYWxzZSkpIHtcbiAgICAgIGxvZy5lcnJvckFuZFRocm93KGAncGxhdGZvcm1WZXJzaW9uJyBtdXN0IGJlIGEgdmFsaWQgdmVyc2lvbiBudW1iZXIuIGAgK1xuICAgICAgICBgJyR7Y2Fwcy5wbGF0Zm9ybVZlcnNpb259JyBpcyBnaXZlbiBpbnN0ZWFkLmApO1xuICAgIH1cblxuICAgIC8vIGZpbmFsbHksIHJldHVybiB0cnVlIHNpbmNlIHRoZSBzdXBlcmNsYXNzIGNoZWNrIHBhc3NlZCwgYXMgZGlkIHRoaXNcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGFzeW5jIGluc3RhbGxBVVQgKCkge1xuICAgIGlmICh0aGlzLmlzU2FmYXJpKCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgdmVyaWZ5QXBwbGljYXRpb25QbGF0Zm9ybSh0aGlzLm9wdHMuYXBwLCB0aGlzLmlzU2ltdWxhdG9yKCksIGlzVHZPUyh0aGlzLm9wdHMucGxhdGZvcm1OYW1lKSk7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAvLyBUT0RPOiBMZXQgaXQgdGhyb3cgYWZ0ZXIgd2UgY29uZmlybSB0aGUgYXJjaGl0ZWN0dXJlIHZlcmlmaWNhdGlvbiBhbGdvcml0aG0gaXMgc3RhYmxlXG4gICAgICBsb2cud2FybihgKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqYCk7XG4gICAgICBsb2cud2FybihgJHt0aGlzLmlzU2ltdWxhdG9yKCkgPyAnU2ltdWxhdG9yJyA6ICdSZWFsIGRldmljZSd9IGFyY2hpdGVjdHVyZSBhcHBlYXJzIHRvIGJlIHVuc3VwcG9ydGVkIGAgK1xuICAgICAgICAgICAgICAgYGJ5IHRoZSAnJHt0aGlzLm9wdHMuYXBwfScgYXBwbGljYXRpb24uIGAgK1xuICAgICAgICAgICAgICAgYE1ha2Ugc3VyZSB0aGUgY29ycmVjdCBkZXBsb3ltZW50IHRhcmdldCBoYXMgYmVlbiBzZWxlY3RlZCBmb3IgaXRzIGNvbXBpbGF0aW9uIGluIFhjb2RlLmApO1xuICAgICAgbG9nLndhcm4oJ0RvblxcJ3QgYmUgc3VycHJpc2VkIGlmIHRoZSBhcHBsaWNhdGlvbiBmYWlscyB0byBsYXVuY2guJyk7XG4gICAgICBsb2cud2FybihgKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqYCk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuaXNSZWFsRGV2aWNlKCkpIHtcbiAgICAgIGF3YWl0IGluc3RhbGxUb1JlYWxEZXZpY2UodGhpcy5vcHRzLmRldmljZSwgdGhpcy5vcHRzLmFwcCwgdGhpcy5vcHRzLmJ1bmRsZUlkLCB0aGlzLm9wdHMubm9SZXNldCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGF3YWl0IGluc3RhbGxUb1NpbXVsYXRvcih0aGlzLm9wdHMuZGV2aWNlLCB0aGlzLm9wdHMuYXBwLCB0aGlzLm9wdHMuYnVuZGxlSWQsIHRoaXMub3B0cy5ub1Jlc2V0KTtcbiAgICB9XG4gICAgaWYgKHRoaXMub3B0cy5vdGhlckFwcHMpIHtcbiAgICAgIGF3YWl0IHRoaXMuaW5zdGFsbE90aGVyQXBwcyh0aGlzLm9wdHMub3RoZXJBcHBzKTtcbiAgICB9XG5cbiAgICBpZiAodXRpbC5oYXNWYWx1ZSh0aGlzLm9wdHMuaW9zSW5zdGFsbFBhdXNlKSkge1xuICAgICAgLy8gaHR0cHM6Ly9naXRodWIuY29tL2FwcGl1bS9hcHBpdW0vaXNzdWVzLzY4ODlcbiAgICAgIGxldCBwYXVzZSA9IHBhcnNlSW50KHRoaXMub3B0cy5pb3NJbnN0YWxsUGF1c2UsIDEwKTtcbiAgICAgIGxvZy5kZWJ1ZyhgaW9zSW5zdGFsbFBhdXNlIHNldC4gUGF1c2luZyAke3BhdXNlfSBtcyBiZWZvcmUgY29udGludWluZ2ApO1xuICAgICAgYXdhaXQgQi5kZWxheShwYXVzZSk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgaW5zdGFsbE90aGVyQXBwcyAob3RoZXJBcHBzKSB7XG4gICAgaWYgKHRoaXMuaXNSZWFsRGV2aWNlKCkpIHtcbiAgICAgIGxvZy53YXJuKCdDYXBhYmlsaXR5IG90aGVyQXBwcyBpcyBvbmx5IHN1cHBvcnRlZCBmb3IgU2ltdWxhdG9ycycpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgb3RoZXJBcHBzID0gdGhpcy5oZWxwZXJzLnBhcnNlQ2Fwc0FycmF5KG90aGVyQXBwcyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgbG9nLmVycm9yQW5kVGhyb3coYENvdWxkIG5vdCBwYXJzZSBcIm90aGVyQXBwc1wiIGNhcGFiaWxpdHk6ICR7ZS5tZXNzYWdlfWApO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IG90aGVyQXBwIG9mIG90aGVyQXBwcykge1xuICAgICAgYXdhaXQgaW5zdGFsbFRvU2ltdWxhdG9yKHRoaXMub3B0cy5kZXZpY2UsIG90aGVyQXBwLCB1bmRlZmluZWQsIHRoaXMub3B0cy5ub1Jlc2V0KTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogU2V0IHJlZHVjZU1vdGlvbiBhcyAnaXNFbmFibGVkJyBvbmx5IHdoZW4gdGhlIGNhcGFiaWxpdGllcyBoYXMgJ3JlZHVjZU1vdGlvbidcbiAgICogVGhlIGNhbGwgaXMgaWdub3JlZCBmb3IgcmVhbCBkZXZpY2VzLlxuICAgKiBAcGFyYW0gez9ib29sZWFufSBpc0VuYWJsZWQgV2V0aGVyIGVuYWJsZSByZWR1Y2VNb3Rpb25cbiAgICovXG4gIGFzeW5jIHNldFJlZHVjZU1vdGlvbiAoaXNFbmFibGVkKSB7XG4gICAgaWYgKHRoaXMuaXNSZWFsRGV2aWNlKCkgfHwgIV8uaXNCb29sZWFuKGlzRW5hYmxlZCkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBsb2cuaW5mbyhgU2V0dGluZyByZWR1Y2VNb3Rpb24gdG8gJHtpc0VuYWJsZWR9YCk7XG4gICAgYXdhaXQgdGhpcy51cGRhdGVTZXR0aW5ncyh7cmVkdWNlTW90aW9uOiBpc0VuYWJsZWR9KTtcbiAgfVxuXG4gIGFzeW5jIHNldEluaXRpYWxPcmllbnRhdGlvbiAob3JpZW50YXRpb24pIHtcbiAgICBpZiAoIV8uaXNTdHJpbmcob3JpZW50YXRpb24pKSB7XG4gICAgICBsb2cuaW5mbygnU2tpcHBpbmcgc2V0dGluZyBvZiB0aGUgaW5pdGlhbCBkaXNwbGF5IG9yaWVudGF0aW9uLiAnICtcbiAgICAgICAgJ1NldCB0aGUgXCJvcmllbnRhdGlvblwiIGNhcGFiaWxpdHkgdG8gZWl0aGVyIFwiTEFORFNDQVBFXCIgb3IgXCJQT1JUUkFJVFwiLCBpZiB0aGlzIGlzIGFuIHVuZGVzaXJlZCBiZWhhdmlvci4nKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgb3JpZW50YXRpb24gPSBvcmllbnRhdGlvbi50b1VwcGVyQ2FzZSgpO1xuICAgIGlmICghXy5pbmNsdWRlcyhbJ0xBTkRTQ0FQRScsICdQT1JUUkFJVCddLCBvcmllbnRhdGlvbikpIHtcbiAgICAgIGxvZy5kZWJ1ZyhgVW5hYmxlIHRvIHNldCBpbml0aWFsIG9yaWVudGF0aW9uIHRvICcke29yaWVudGF0aW9ufSdgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbG9nLmRlYnVnKGBTZXR0aW5nIGluaXRpYWwgb3JpZW50YXRpb24gdG8gJyR7b3JpZW50YXRpb259J2ApO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLnByb3h5Q29tbWFuZCgnL29yaWVudGF0aW9uJywgJ1BPU1QnLCB7b3JpZW50YXRpb259KTtcbiAgICAgIHRoaXMub3B0cy5jdXJPcmllbnRhdGlvbiA9IG9yaWVudGF0aW9uO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgbG9nLndhcm4oYFNldHRpbmcgaW5pdGlhbCBvcmllbnRhdGlvbiBmYWlsZWQgd2l0aDogJHtlcnIubWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cblxuICBfZ2V0Q29tbWFuZFRpbWVvdXQgKGNtZE5hbWUpIHtcbiAgICBpZiAodGhpcy5vcHRzLmNvbW1hbmRUaW1lb3V0cykge1xuICAgICAgaWYgKGNtZE5hbWUgJiYgXy5oYXModGhpcy5vcHRzLmNvbW1hbmRUaW1lb3V0cywgY21kTmFtZSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMub3B0cy5jb21tYW5kVGltZW91dHNbY21kTmFtZV07XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5vcHRzLmNvbW1hbmRUaW1lb3V0c1tERUZBVUxUX1RJTUVPVVRfS0VZXTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogR2V0IHNlc3Npb24gY2FwYWJpbGl0aWVzIG1lcmdlZCB3aXRoIHdoYXQgV0RBIHJlcG9ydHNcbiAgICogVGhpcyBpcyBhIGxpYnJhcnkgY29tbWFuZCBidXQgbmVlZHMgdG8gY2FsbCAnc3VwZXInIHNvIGNhbid0IGJlIG9uXG4gICAqIGEgaGVscGVyIG9iamVjdFxuICAgKi9cbiAgYXN5bmMgZ2V0U2Vzc2lvbiAoKSB7XG4gICAgLy8gY2FsbCBzdXBlciB0byBnZXQgZXZlbnQgdGltaW5ncywgZXRjLi4uXG4gICAgY29uc3QgZHJpdmVyU2Vzc2lvbiA9IGF3YWl0IHN1cGVyLmdldFNlc3Npb24oKTtcbiAgICBpZiAoIXRoaXMud2RhQ2Fwcykge1xuICAgICAgdGhpcy53ZGFDYXBzID0gYXdhaXQgdGhpcy5wcm94eUNvbW1hbmQoJy8nLCAnR0VUJyk7XG4gICAgfVxuICAgIGlmICghdGhpcy5kZXZpY2VDYXBzKSB7XG4gICAgICBjb25zdCB7c3RhdHVzQmFyU2l6ZSwgc2NhbGV9ID0gYXdhaXQgdGhpcy5nZXRTY3JlZW5JbmZvKCk7XG4gICAgICB0aGlzLmRldmljZUNhcHMgPSB7XG4gICAgICAgIHBpeGVsUmF0aW86IHNjYWxlLFxuICAgICAgICBzdGF0QmFySGVpZ2h0OiBzdGF0dXNCYXJTaXplLmhlaWdodCxcbiAgICAgICAgdmlld3BvcnRSZWN0OiBhd2FpdCB0aGlzLmdldFZpZXdwb3J0UmVjdCgpLFxuICAgICAgfTtcbiAgICB9XG4gICAgbG9nLmluZm8oJ01lcmdpbmcgV0RBIGNhcHMgb3ZlciBBcHBpdW0gY2FwcyBmb3Igc2Vzc2lvbiBkZXRhaWwgcmVzcG9uc2UnKTtcbiAgICByZXR1cm4gT2JqZWN0LmFzc2lnbih7dWRpZDogdGhpcy5vcHRzLnVkaWR9LCBkcml2ZXJTZXNzaW9uLFxuICAgICAgdGhpcy53ZGFDYXBzLmNhcGFiaWxpdGllcywgdGhpcy5kZXZpY2VDYXBzKTtcbiAgfVxuXG4gIGFzeW5jIHJlc2V0ICgpIHtcbiAgICBpZiAodGhpcy5vcHRzLm5vUmVzZXQpIHtcbiAgICAgIC8vIFRoaXMgaXMgdG8gbWFrZSBzdXJlIHJlc2V0IGhhcHBlbnMgZXZlbiBpZiBub1Jlc2V0IGlzIHNldCB0byB0cnVlXG4gICAgICBsZXQgb3B0cyA9IF8uY2xvbmVEZWVwKHRoaXMub3B0cyk7XG4gICAgICBvcHRzLm5vUmVzZXQgPSBmYWxzZTtcbiAgICAgIG9wdHMuZnVsbFJlc2V0ID0gZmFsc2U7XG4gICAgICBjb25zdCBzaHV0ZG93bkhhbmRsZXIgPSB0aGlzLnJlc2V0T25VbmV4cGVjdGVkU2h1dGRvd247XG4gICAgICB0aGlzLnJlc2V0T25VbmV4cGVjdGVkU2h1dGRvd24gPSAoKSA9PiB7fTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMucnVuUmVzZXQob3B0cyk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0aGlzLnJlc2V0T25VbmV4cGVjdGVkU2h1dGRvd24gPSBzaHV0ZG93bkhhbmRsZXI7XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IHN1cGVyLnJlc2V0KCk7XG4gIH1cbn1cblxuT2JqZWN0LmFzc2lnbihYQ1VJVGVzdERyaXZlci5wcm90b3R5cGUsIGNvbW1hbmRzKTtcblxuZXhwb3J0IGRlZmF1bHQgWENVSVRlc3REcml2ZXI7XG5leHBvcnQgeyBYQ1VJVGVzdERyaXZlciB9O1xuIl0sImZpbGUiOiJsaWIvZHJpdmVyLmpzIiwic291cmNlUm9vdCI6Ii4uLy4uIn0=
