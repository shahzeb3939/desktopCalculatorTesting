"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.detectUdid = detectUdid;
exports.getAndCheckXcodeVersion = getAndCheckXcodeVersion;
exports.getAndCheckIosSdkVersion = getAndCheckIosSdkVersion;
exports.checkAppPresent = checkAppPresent;
exports.getDriverInfo = getDriverInfo;
exports.clearSystemFiles = clearSystemFiles;
exports.translateDeviceName = translateDeviceName;
exports.normalizeCommandTimeouts = normalizeCommandTimeouts;
exports.resetXCTestProcesses = resetXCTestProcesses;
exports.getPIDsUsingPattern = getPIDsUsingPattern;
exports.markSystemFilesForCleanup = markSystemFilesForCleanup;
exports.printUser = printUser;
exports.getPIDsListeningOnPort = getPIDsListeningOnPort;
exports.encodeBase64OrUpload = encodeBase64OrUpload;
exports.removeAllSessionWebSocketHandlers = removeAllSessionWebSocketHandlers;
exports.verifyApplicationPlatform = verifyApplicationPlatform;
exports.isTvOS = isTvOS;
exports.isLocalHost = isLocalHost;
exports.normalizePlatformVersion = normalizePlatformVersion;
exports.DEFAULT_TIMEOUT_KEY = void 0;

require("source-map-support/register");

var _bluebird = _interopRequireDefault(require("bluebird"));

var _appiumIosDevice = require("appium-ios-device");

var _appiumSupport = require("appium-support");

var _path = _interopRequireDefault(require("path"));

var _appiumIosDriver = require("appium-ios-driver");

var _teen_process = require("teen_process");

var _appiumXcode = _interopRequireDefault(require("appium-xcode"));

var _lodash = _interopRequireDefault(require("lodash"));

var _logger = _interopRequireDefault(require("./logger"));

var _iosGenericSimulators = _interopRequireDefault(require("./ios-generic-simulators"));

var _fs2 = _interopRequireDefault(require("fs"));

var _url = _interopRequireDefault(require("url"));

var _v = _interopRequireDefault(require("v8"));

var _desiredCaps = require("./desired-caps");

var _semver = _interopRequireDefault(require("semver"));

const DEFAULT_TIMEOUT_KEY = 'default';
exports.DEFAULT_TIMEOUT_KEY = DEFAULT_TIMEOUT_KEY;

async function detectUdid() {
  _logger.default.debug('Auto-detecting real device udid...');

  const udids = await _appiumIosDevice.utilities.getConnectedDevices();

  if (_lodash.default.isEmpty(udids)) {
    throw new Error('No device is connected to the host');
  }

  const udid = _lodash.default.last(udids);

  if (udids.length > 1) {
    _logger.default.warn(`Multiple devices found: ${udids.join(', ')}`);

    _logger.default.warn(`Choosing '${udid}'. If this is wrong, manually set with 'udid' desired capability`);
  }

  _logger.default.debug(`Detected real device udid: '${udid}'`);

  return udid;
}

async function getAndCheckXcodeVersion() {
  let version;

  try {
    version = await _appiumXcode.default.getVersion(true);
  } catch (err) {
    _logger.default.debug(err);

    _logger.default.errorAndThrow(`Could not determine Xcode version: ${err.message}`);
  }

  if (version.versionFloat < 7.3) {
    _logger.default.errorAndThrow(`Xcode version '${version.versionString}'. Support for ` + `Xcode ${version.versionString} is not supported. ` + `Please upgrade to version 7.3 or higher`);
  }

  return version;
}

async function getAndCheckIosSdkVersion() {
  try {
    return await _appiumXcode.default.getMaxIOSSDK();
  } catch (err) {
    _logger.default.errorAndThrow(`Could not determine iOS SDK version: ${err.message}`);
  }
}

function getGenericSimulatorForIosVersion(platformVersion, deviceName) {
  let genericSimulators = _iosGenericSimulators.default[deviceName];

  if (genericSimulators) {
    genericSimulators = genericSimulators.sort(([simOne], [simTwo]) => _appiumSupport.util.compareVersions(simOne, '<', simTwo) ? -1 : 1);
    let genericIosSimulator;

    for (const [platformVersionFromList, iosSimulator] of genericSimulators) {
      if (_appiumSupport.util.compareVersions(platformVersionFromList, '>', platformVersion)) {
        break;
      }

      genericIosSimulator = iosSimulator;
    }

    return genericIosSimulator;
  }
}

function translateDeviceName(platformVersion, deviceName = '') {
  const deviceNameTranslated = getGenericSimulatorForIosVersion(platformVersion, deviceName.toLowerCase().trim());

  if (deviceNameTranslated) {
    _logger.default.debug(`Changing deviceName from '${deviceName}' to '${deviceNameTranslated}'`);

    return deviceNameTranslated;
  }

  return deviceName;
}

const derivedDataCleanupMarkers = new Map();

async function markSystemFilesForCleanup(wda) {
  if (!wda || !(await wda.retrieveDerivedDataPath())) {
    _logger.default.warn('No WebDriverAgent derived data available, so unable to mark system files for cleanup');

    return;
  }

  const logsRoot = _path.default.resolve((await wda.retrieveDerivedDataPath()), 'Logs');

  let markersCount = 0;

  if (derivedDataCleanupMarkers.has(logsRoot)) {
    markersCount = derivedDataCleanupMarkers.get(logsRoot);
  }

  derivedDataCleanupMarkers.set(logsRoot, ++markersCount);
}

async function clearSystemFiles(wda) {
  if (!wda || !(await wda.retrieveDerivedDataPath())) {
    _logger.default.warn('No WebDriverAgent derived data available, so unable to clear system files');

    return;
  }

  const logsRoot = _path.default.resolve((await wda.retrieveDerivedDataPath()), 'Logs');

  if (derivedDataCleanupMarkers.has(logsRoot)) {
    let markersCount = derivedDataCleanupMarkers.get(logsRoot);
    derivedDataCleanupMarkers.set(logsRoot, --markersCount);

    if (markersCount > 0) {
      _logger.default.info(`Not cleaning '${logsRoot}' folder, because the other session does not expect it to be cleaned`);

      return;
    }
  }

  derivedDataCleanupMarkers.set(logsRoot, 0);
  const cleanupCmd = `find -E /private/var/folders ` + `-regex '.*/Session-WebDriverAgentRunner.*\\.log$|.*/StandardOutputAndStandardError\\.txt$' ` + `-type f -exec sh -c 'echo "" > "{}"' \\;`;
  const cleanupTask = new _teen_process.SubProcess('bash', ['-c', cleanupCmd], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await cleanupTask.start(0, true);

  _logger.default.debug(`Started background XCTest logs cleanup: ${cleanupCmd}`);

  if (await _appiumSupport.fs.exists(logsRoot)) {
    _logger.default.info(`Cleaning test logs in '${logsRoot}' folder`);

    await _appiumIosDriver.utils.clearLogs([logsRoot]);
    return;
  }

  _logger.default.info(`There is no ${logsRoot} folder, so not cleaning files`);
}

async function checkAppPresent(app) {
  _logger.default.debug(`Checking whether app '${app}' is actually present on file system`);

  if (!(await _appiumSupport.fs.exists(app))) {
    _logger.default.errorAndThrow(`Could not find app at '${app}'`);
  }

  _logger.default.debug('App is present');
}

async function getDriverInfo() {
  const stat = await _appiumSupport.fs.stat(_path.default.resolve(__dirname, '..'));
  const built = stat.mtime.getTime();

  const pkg = require(__filename.includes('build/lib/utils') ? '../../package.json' : '../package.json');

  const version = pkg.version;
  return {
    built,
    version
  };
}

function normalizeCommandTimeouts(value) {
  if (typeof value !== 'string') {
    return value;
  }

  let result = {};

  if (!isNaN(value)) {
    result[DEFAULT_TIMEOUT_KEY] = _lodash.default.toInteger(value);
    return result;
  }

  try {
    result = JSON.parse(value);

    if (!_lodash.default.isPlainObject(result)) {
      throw new Error();
    }
  } catch (err) {
    _logger.default.errorAndThrow(`"commandTimeouts" capability should be a valid JSON object. "${value}" was given instead`);
  }

  for (let [cmd, timeout] of _lodash.default.toPairs(result)) {
    if (!_lodash.default.isInteger(timeout) || timeout <= 0) {
      _logger.default.errorAndThrow(`The timeout for "${cmd}" should be a valid natural number of milliseconds. "${timeout}" was given instead`);
    }
  }

  return result;
}

async function getPIDsUsingPattern(pattern, opts = {}) {
  const {
    multi = false,
    ignoreCase = true
  } = opts;
  const args = [`-${ignoreCase ? 'i' : ''}f${multi ? '' : 'n'}`, pattern];

  try {
    const {
      stdout
    } = await (0, _teen_process.exec)('pgrep', args);

    if (multi) {
      const result = stdout.split('\n').filter(x => parseInt(x, 10)).map(x => `${parseInt(x, 10)}`);
      return _lodash.default.isEmpty(result) ? null : result;
    }

    const pid = parseInt(stdout, 10);
    return isNaN(pid) ? null : `${pid}`;
  } catch (err) {
    _logger.default.debug(`'pgrep ${args.join(' ')}' didn't detect any matching processes. Return code: ${err.code}`);

    return null;
  }
}

async function killAppUsingPattern(pgrepPattern) {
  for (const signal of [2, 15, 9]) {
    if (!(await getPIDsUsingPattern(pgrepPattern))) {
      return;
    }

    const args = [`-${signal}`, '-if', pgrepPattern];

    try {
      await (0, _teen_process.exec)('pkill', args);
    } catch (err) {
      _logger.default.debug(`pkill ${args.join(' ')} -> ${err.message}`);
    }

    await _bluebird.default.delay(100);
  }
}

async function resetXCTestProcesses(udid, isSimulator) {
  const processPatterns = [`xcodebuild.*${udid}`];

  if (isSimulator) {
    processPatterns.push(`${udid}.*XCTRunner`);
  }

  _logger.default.debug(`Killing running processes '${processPatterns.join(', ')}' for the device ${udid}...`);

  for (const pgrepPattern of processPatterns) {
    await killAppUsingPattern(pgrepPattern);
  }
}

async function printUser() {
  try {
    let {
      stdout
    } = await (0, _teen_process.exec)('whoami');

    _logger.default.debug(`Current user: '${stdout.trim()}'`);
  } catch (err) {
    _logger.default.debug(`Unable to get username running server: ${err.message}`);
  }
}

async function getPIDsListeningOnPort(port, filteringFunc = null) {
  const result = [];

  try {
    const {
      stdout
    } = await (0, _teen_process.exec)('lsof', ['-ti', `tcp:${port}`]);
    result.push(...stdout.trim().split(/\n+/));
  } catch (e) {
    return result;
  }

  if (!_lodash.default.isFunction(filteringFunc)) {
    return result;
  }

  return await _bluebird.default.filter(result, async x => {
    const {
      stdout
    } = await (0, _teen_process.exec)('ps', ['-p', x, '-o', 'command']);
    return await filteringFunc(stdout);
  });
}

async function encodeBase64OrUpload(localFile, remotePath = null, uploadOptions = {}) {
  if (!(await _appiumSupport.fs.exists(localFile))) {
    _logger.default.errorAndThrow(`The file at '${localFile}' does not exist or is not accessible`);
  }

  const {
    size
  } = await _appiumSupport.fs.stat(localFile);

  _logger.default.debug(`The size of the file is ${_appiumSupport.util.toReadableSizeString(size)}`);

  if (_lodash.default.isEmpty(remotePath)) {
    const maxMemoryLimit = _v.default.getHeapStatistics().total_available_size / 2;

    if (size >= maxMemoryLimit) {
      _logger.default.info(`The file might be too large to fit into the process memory ` + `(${_appiumSupport.util.toReadableSizeString(size)} >= ${_appiumSupport.util.toReadableSizeString(maxMemoryLimit)}). ` + `Provide a link to a remote writable location for video upload ` + `(http(s) and ftp protocols are supported) if you experience Out Of Memory errors`);
    }

    const content = await _appiumSupport.fs.readFile(localFile);
    return content.toString('base64');
  }

  const remoteUrl = _url.default.parse(remotePath);

  let options = {};
  const {
    user,
    pass,
    method
  } = uploadOptions;

  if (remoteUrl.protocol.startsWith('http')) {
    options = {
      url: remoteUrl.href,
      method: method || 'PUT',
      multipart: [{
        body: _fs2.default.createReadStream(localFile)
      }]
    };

    if (user && pass) {
      options.auth = {
        user,
        pass
      };
    }
  } else if (remoteUrl.protocol === 'ftp:') {
    options = {
      host: remoteUrl.hostname,
      port: remoteUrl.port || 21
    };

    if (user && pass) {
      options.user = user;
      options.pass = pass;
    }
  }

  await _appiumSupport.net.uploadFile(localFile, remotePath, options);
  return '';
}

async function removeAllSessionWebSocketHandlers(server, sessionId) {
  if (!server || !_lodash.default.isFunction(server.getWebSocketHandlers)) {
    return;
  }

  const activeHandlers = await server.getWebSocketHandlers(sessionId);

  for (const pathname of _lodash.default.keys(activeHandlers)) {
    await server.removeWebSocketHandler(pathname);
  }
}

async function verifyApplicationPlatform(app, isSimulator, isTvOS) {
  _logger.default.debug('Verifying application platform');

  const infoPlist = _path.default.resolve(app, 'Info.plist');

  if (!(await _appiumSupport.fs.exists(infoPlist))) {
    _logger.default.debug(`'${infoPlist}' does not exist`);

    return null;
  }

  const {
    CFBundleSupportedPlatforms
  } = await _appiumSupport.plist.parsePlistFile(infoPlist);

  _logger.default.debug(`CFBundleSupportedPlatforms: ${JSON.stringify(CFBundleSupportedPlatforms)}`);

  if (!_lodash.default.isArray(CFBundleSupportedPlatforms)) {
    _logger.default.debug(`CFBundleSupportedPlatforms key does not exist in '${infoPlist}'`);

    return null;
  }

  const expectedPlatform = isSimulator ? isTvOS ? 'AppleTVSimulator' : 'iPhoneSimulator' : isTvOS ? 'AppleTVOS' : 'iPhoneOS';
  const isAppSupported = CFBundleSupportedPlatforms.includes(expectedPlatform);

  if (isAppSupported) {
    return true;
  }

  throw new Error(`${isSimulator ? 'Simulator' : 'Real device'} architecture is unsupported by the '${app}' application. ` + `Make sure the correct deployment target has been selected for its compilation in Xcode.`);
}

function isTvOS(platformName) {
  return _lodash.default.toLower(platformName) === _lodash.default.toLower(_desiredCaps.PLATFORM_NAME_TVOS);
}

function isLocalHost(urlString) {
  try {
    const {
      hostname
    } = _url.default.parse(urlString);

    return ['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(hostname);
  } catch (ign) {
    _logger.default.warn(`'${urlString}' cannot be parsed as a valid URL`);
  }

  return false;
}

function normalizePlatformVersion(originalVersion) {
  const normalizedVersion = _appiumSupport.util.coerceVersion(originalVersion, false);

  if (!normalizedVersion) {
    throw new Error(`The platform version '${originalVersion}' should be a valid version number`);
  }

  const {
    major,
    minor
  } = new _semver.default.SemVer(normalizedVersion);
  return `${major}.${minor}`;
}require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImxpYi91dGlscy5qcyJdLCJuYW1lcyI6WyJERUZBVUxUX1RJTUVPVVRfS0VZIiwiZGV0ZWN0VWRpZCIsImxvZyIsImRlYnVnIiwidWRpZHMiLCJ1dGlsaXRpZXMiLCJnZXRDb25uZWN0ZWREZXZpY2VzIiwiXyIsImlzRW1wdHkiLCJFcnJvciIsInVkaWQiLCJsYXN0IiwibGVuZ3RoIiwid2FybiIsImpvaW4iLCJnZXRBbmRDaGVja1hjb2RlVmVyc2lvbiIsInZlcnNpb24iLCJ4Y29kZSIsImdldFZlcnNpb24iLCJlcnIiLCJlcnJvckFuZFRocm93IiwibWVzc2FnZSIsInZlcnNpb25GbG9hdCIsInZlcnNpb25TdHJpbmciLCJnZXRBbmRDaGVja0lvc1Nka1ZlcnNpb24iLCJnZXRNYXhJT1NTREsiLCJnZXRHZW5lcmljU2ltdWxhdG9yRm9ySW9zVmVyc2lvbiIsInBsYXRmb3JtVmVyc2lvbiIsImRldmljZU5hbWUiLCJnZW5lcmljU2ltdWxhdG9ycyIsImlvc0dlbmVyaWNTaW11bGF0b3JzIiwic29ydCIsInNpbU9uZSIsInNpbVR3byIsInV0aWwiLCJjb21wYXJlVmVyc2lvbnMiLCJnZW5lcmljSW9zU2ltdWxhdG9yIiwicGxhdGZvcm1WZXJzaW9uRnJvbUxpc3QiLCJpb3NTaW11bGF0b3IiLCJ0cmFuc2xhdGVEZXZpY2VOYW1lIiwiZGV2aWNlTmFtZVRyYW5zbGF0ZWQiLCJ0b0xvd2VyQ2FzZSIsInRyaW0iLCJkZXJpdmVkRGF0YUNsZWFudXBNYXJrZXJzIiwiTWFwIiwibWFya1N5c3RlbUZpbGVzRm9yQ2xlYW51cCIsIndkYSIsInJldHJpZXZlRGVyaXZlZERhdGFQYXRoIiwibG9nc1Jvb3QiLCJwYXRoIiwicmVzb2x2ZSIsIm1hcmtlcnNDb3VudCIsImhhcyIsImdldCIsInNldCIsImNsZWFyU3lzdGVtRmlsZXMiLCJpbmZvIiwiY2xlYW51cENtZCIsImNsZWFudXBUYXNrIiwiU3ViUHJvY2VzcyIsImRldGFjaGVkIiwic3RkaW8iLCJzdGFydCIsImZzIiwiZXhpc3RzIiwiaW9zVXRpbHMiLCJjbGVhckxvZ3MiLCJjaGVja0FwcFByZXNlbnQiLCJhcHAiLCJnZXREcml2ZXJJbmZvIiwic3RhdCIsIl9fZGlybmFtZSIsImJ1aWx0IiwibXRpbWUiLCJnZXRUaW1lIiwicGtnIiwicmVxdWlyZSIsIl9fZmlsZW5hbWUiLCJpbmNsdWRlcyIsIm5vcm1hbGl6ZUNvbW1hbmRUaW1lb3V0cyIsInZhbHVlIiwicmVzdWx0IiwiaXNOYU4iLCJ0b0ludGVnZXIiLCJKU09OIiwicGFyc2UiLCJpc1BsYWluT2JqZWN0IiwiY21kIiwidGltZW91dCIsInRvUGFpcnMiLCJpc0ludGVnZXIiLCJnZXRQSURzVXNpbmdQYXR0ZXJuIiwicGF0dGVybiIsIm9wdHMiLCJtdWx0aSIsImlnbm9yZUNhc2UiLCJhcmdzIiwic3Rkb3V0Iiwic3BsaXQiLCJmaWx0ZXIiLCJ4IiwicGFyc2VJbnQiLCJtYXAiLCJwaWQiLCJjb2RlIiwia2lsbEFwcFVzaW5nUGF0dGVybiIsInBncmVwUGF0dGVybiIsInNpZ25hbCIsIkIiLCJkZWxheSIsInJlc2V0WENUZXN0UHJvY2Vzc2VzIiwiaXNTaW11bGF0b3IiLCJwcm9jZXNzUGF0dGVybnMiLCJwdXNoIiwicHJpbnRVc2VyIiwiZ2V0UElEc0xpc3RlbmluZ09uUG9ydCIsInBvcnQiLCJmaWx0ZXJpbmdGdW5jIiwiZSIsImlzRnVuY3Rpb24iLCJlbmNvZGVCYXNlNjRPclVwbG9hZCIsImxvY2FsRmlsZSIsInJlbW90ZVBhdGgiLCJ1cGxvYWRPcHRpb25zIiwic2l6ZSIsInRvUmVhZGFibGVTaXplU3RyaW5nIiwibWF4TWVtb3J5TGltaXQiLCJ2OCIsImdldEhlYXBTdGF0aXN0aWNzIiwidG90YWxfYXZhaWxhYmxlX3NpemUiLCJjb250ZW50IiwicmVhZEZpbGUiLCJ0b1N0cmluZyIsInJlbW90ZVVybCIsInVybCIsIm9wdGlvbnMiLCJ1c2VyIiwicGFzcyIsIm1ldGhvZCIsInByb3RvY29sIiwic3RhcnRzV2l0aCIsImhyZWYiLCJtdWx0aXBhcnQiLCJib2R5IiwiX2ZzIiwiY3JlYXRlUmVhZFN0cmVhbSIsImF1dGgiLCJob3N0IiwiaG9zdG5hbWUiLCJuZXQiLCJ1cGxvYWRGaWxlIiwicmVtb3ZlQWxsU2Vzc2lvbldlYlNvY2tldEhhbmRsZXJzIiwic2VydmVyIiwic2Vzc2lvbklkIiwiZ2V0V2ViU29ja2V0SGFuZGxlcnMiLCJhY3RpdmVIYW5kbGVycyIsInBhdGhuYW1lIiwia2V5cyIsInJlbW92ZVdlYlNvY2tldEhhbmRsZXIiLCJ2ZXJpZnlBcHBsaWNhdGlvblBsYXRmb3JtIiwiaXNUdk9TIiwiaW5mb1BsaXN0IiwiQ0ZCdW5kbGVTdXBwb3J0ZWRQbGF0Zm9ybXMiLCJwbGlzdCIsInBhcnNlUGxpc3RGaWxlIiwic3RyaW5naWZ5IiwiaXNBcnJheSIsImV4cGVjdGVkUGxhdGZvcm0iLCJpc0FwcFN1cHBvcnRlZCIsInBsYXRmb3JtTmFtZSIsInRvTG93ZXIiLCJQTEFURk9STV9OQU1FX1RWT1MiLCJpc0xvY2FsSG9zdCIsInVybFN0cmluZyIsImlnbiIsIm5vcm1hbGl6ZVBsYXRmb3JtVmVyc2lvbiIsIm9yaWdpbmFsVmVyc2lvbiIsIm5vcm1hbGl6ZWRWZXJzaW9uIiwiY29lcmNlVmVyc2lvbiIsIm1ham9yIiwibWlub3IiLCJzZW12ZXIiLCJTZW1WZXIiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUVBLE1BQU1BLG1CQUFtQixHQUFHLFNBQTVCOzs7QUFHQSxlQUFlQyxVQUFmLEdBQTZCO0FBQzNCQyxrQkFBSUMsS0FBSixDQUFVLG9DQUFWOztBQUNBLFFBQU1DLEtBQUssR0FBRyxNQUFNQywyQkFBVUMsbUJBQVYsRUFBcEI7O0FBQ0EsTUFBSUMsZ0JBQUVDLE9BQUYsQ0FBVUosS0FBVixDQUFKLEVBQXNCO0FBQ3BCLFVBQU0sSUFBSUssS0FB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Q0FBa0JMLGlCQUFsQixDQUF2QjtBQUNBLFNBQVEsR0FBRUUsS0FBTSxJQUFHQyxLQUFNLEVBQXpCO0FBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgQiBmcm9tICdibHVlYmlyZCc7XG5pbXBvcnQgeyB1dGlsaXRpZXMgfSBmcm9tICdhcHBpdW0taW9zLWRldmljZSc7XG5pbXBvcnQgeyBmcywgdXRpbCwgbmV0LCBwbGlzdCB9IGZyb20gJ2FwcGl1bS1zdXBwb3J0JztcbmltcG9ydCBwYXRoIGZyb20gJ3BhdGgnO1xuaW1wb3J0IHsgdXRpbHMgYXMgaW9zVXRpbHMgfSBmcm9tICdhcHBpdW0taW9zLWRyaXZlcic7XG5pbXBvcnQgeyBTdWJQcm9jZXNzLCBleGVjIH0gZnJvbSAndGVlbl9wcm9jZXNzJztcbmltcG9ydCB4Y29kZSBmcm9tICdhcHBpdW0teGNvZGUnO1xuaW1wb3J0IF8gZnJvbSAnbG9kYXNoJztcbmltcG9ydCBsb2cgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IGlvc0dlbmVyaWNTaW11bGF0b3JzIGZyb20gJy4vaW9zLWdlbmVyaWMtc2ltdWxhdG9ycyc7XG5pbXBvcnQgX2ZzIGZyb20gJ2ZzJztcbmltcG9ydCB1cmwgZnJvbSAndXJsJztcbmltcG9ydCB2OCBmcm9tICd2OCc7XG5pbXBvcnQgeyBQTEFURk9STV9OQU1FX1RWT1MgfSBmcm9tICcuL2Rlc2lyZWQtY2Fwcyc7XG5pbXBvcnQgc2VtdmVyIGZyb20gJ3NlbXZlcic7XG5cbmNvbnN0IERFRkFVTFRfVElNRU9VVF9LRVkgPSAnZGVmYXVsdCc7XG5cblxuYXN5bmMgZnVuY3Rpb24gZGV0ZWN0VWRpZCAoKSB7XG4gIGxvZy5kZWJ1ZygnQXV0by1kZXRlY3RpbmcgcmVhbCBkZXZpY2UgdWRpZC4uLicpO1xuICBjb25zdCB1ZGlkcyA9IGF3YWl0IHV0aWxpdGllcy5nZXRDb25uZWN0ZWREZXZpY2VzKCk7XG4gIGlmIChfLmlzRW1wdHkodWRpZHMpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdObyBkZXZpY2UgaXMgY29ubmVjdGVkIHRvIHRoZSBob3N0Jyk7XG4gIH1cbiAgY29uc3QgdWRpZCA9IF8ubGFzdCh1ZGlkcyk7XG4gIGlmICh1ZGlkcy5sZW5ndGggPiAxKSB7XG4gICAgbG9nLndhcm4oYE11bHRpcGxlIGRldmljZXMgZm91bmQ6ICR7dWRpZHMuam9pbignLCAnKX1gKTtcbiAgICBsb2cud2FybihgQ2hvb3NpbmcgJyR7dWRpZH0nLiBJZiB0aGlzIGlzIHdyb25nLCBtYW51YWxseSBzZXQgd2l0aCAndWRpZCcgZGVzaXJlZCBjYXBhYmlsaXR5YCk7XG4gIH1cbiAgbG9nLmRlYnVnKGBEZXRlY3RlZCByZWFsIGRldmljZSB1ZGlkOiAnJHt1ZGlkfSdgKTtcbiAgcmV0dXJuIHVkaWQ7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEFuZENoZWNrWGNvZGVWZXJzaW9uICgpIHtcbiAgbGV0IHZlcnNpb247XG4gIHRyeSB7XG4gICAgdmVyc2lvbiA9IGF3YWl0IHhjb2RlLmdldFZlcnNpb24odHJ1ZSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZy5kZWJ1ZyhlcnIpO1xuICAgIGxvZy5lcnJvckFuZFRocm93KGBDb3VsZCBub3QgZGV0ZXJtaW5lIFhjb2RlIHZlcnNpb246ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gIH1cblxuICAvLyB3ZSBkbyBub3Qgc3VwcG9ydCBYY29kZXMgPCA3LjMsXG4gIGlmICh2ZXJzaW9uLnZlcnNpb25GbG9hdCA8IDcuMykge1xuICAgIGxvZy5lcnJvckFuZFRocm93KGBYY29kZSB2ZXJzaW9uICcke3ZlcnNpb24udmVyc2lvblN0cmluZ30nLiBTdXBwb3J0IGZvciBgICtcbiAgICAgICAgICAgICAgICAgICAgICBgWGNvZGUgJHt2ZXJzaW9uLnZlcnNpb25TdHJpbmd9IGlzIG5vdCBzdXBwb3J0ZWQuIGAgK1xuICAgICAgICAgICAgICAgICAgICAgIGBQbGVhc2UgdXBncmFkZSB0byB2ZXJzaW9uIDcuMyBvciBoaWdoZXJgKTtcbiAgfVxuICByZXR1cm4gdmVyc2lvbjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0QW5kQ2hlY2tJb3NTZGtWZXJzaW9uICgpIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgeGNvZGUuZ2V0TWF4SU9TU0RLKCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZy5lcnJvckFuZFRocm93KGBDb3VsZCBub3QgZGV0ZXJtaW5lIGlPUyBTREsgdmVyc2lvbjogJHtlcnIubWVzc2FnZX1gKTtcbiAgfVxufVxuXG4vKipcbiAqIEdldCB0aGUgZ2VuZXJpYyBzaW11bGF0b3IgZm9yIGEgZ2l2ZW4gSU9TIHZlcnNpb24gYW5kIGRldmljZSB0eXBlIChpUGhvbmUsIGlQYWQpXG4gKlxuICogQHBhcmFtIHtzdHJpbmd8bnVtYmVyfSBwbGF0Zm9ybVZlcnNpb24gSU9TIHZlcnNpb24uIGUuZy4pIDEzLjBcbiAqIEBwYXJhbSB7c3RyaW5nfSBkZXZpY2VOYW1lIFR5cGUgb2YgSU9TIGRldmljZS4gQ2FuIGJlIGlQaG9uZSwgaVBhZCAocG9zc2libHkgbW9yZSBpbiB0aGUgZnV0dXJlKVxuICpcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEdlbmVyaWMgaVBob25lIG9yIGlQYWQgc2ltdWxhdG9yIChpZiBhcHBsaWNhYmxlKVxuICovXG5mdW5jdGlvbiBnZXRHZW5lcmljU2ltdWxhdG9yRm9ySW9zVmVyc2lvbiAocGxhdGZvcm1WZXJzaW9uLCBkZXZpY2VOYW1lKSB7XG4gIGxldCBnZW5lcmljU2ltdWxhdG9ycyA9IGlvc0dlbmVyaWNTaW11bGF0b3JzW2RldmljZU5hbWVdO1xuXG4gIGlmIChnZW5lcmljU2ltdWxhdG9ycykge1xuICAgIGdlbmVyaWNTaW11bGF0b3JzID0gZ2VuZXJpY1NpbXVsYXRvcnMuc29ydCgoW3NpbU9uZV0sIFtzaW1Ud29dKSA9PiB1dGlsLmNvbXBhcmVWZXJzaW9ucyhzaW1PbmUsICc8Jywgc2ltVHdvKSA/IC0xIDogMSk7XG5cbiAgICAvLyBGaW5kIHRoZSBoaWdoZXN0IGlPUyB2ZXJzaW9uIGluIHRoZSBsaXN0IHRoYXQgaXMgYmVsb3cgdGhlIHByb3ZpZGVkIHZlcnNpb25cbiAgICBsZXQgZ2VuZXJpY0lvc1NpbXVsYXRvcjtcbiAgICBmb3IgKGNvbnN0IFtwbGF0Zm9ybVZlcnNpb25Gcm9tTGlzdCwgaW9zU2ltdWxhdG9yXSBvZiBnZW5lcmljU2ltdWxhdG9ycykge1xuICAgICAgaWYgKHV0aWwuY29tcGFyZVZlcnNpb25zKHBsYXRmb3JtVmVyc2lvbkZyb21MaXN0LCAnPicsIHBsYXRmb3JtVmVyc2lvbikpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBnZW5lcmljSW9zU2ltdWxhdG9yID0gaW9zU2ltdWxhdG9yO1xuICAgIH1cbiAgICByZXR1cm4gZ2VuZXJpY0lvc1NpbXVsYXRvcjtcbiAgfVxufVxuXG5mdW5jdGlvbiB0cmFuc2xhdGVEZXZpY2VOYW1lIChwbGF0Zm9ybVZlcnNpb24sIGRldmljZU5hbWUgPSAnJykge1xuICBjb25zdCBkZXZpY2VOYW1lVHJhbnNsYXRlZCA9IGdldEdlbmVyaWNTaW11bGF0b3JGb3JJb3NWZXJzaW9uKHBsYXRmb3JtVmVyc2lvbiwgZGV2aWNlTmFtZS50b0xvd2VyQ2FzZSgpLnRyaW0oKSk7XG4gIGlmIChkZXZpY2VOYW1lVHJhbnNsYXRlZCkge1xuICAgIGxvZy5kZWJ1ZyhgQ2hhbmdpbmcgZGV2aWNlTmFtZSBmcm9tICcke2RldmljZU5hbWV9JyB0byAnJHtkZXZpY2VOYW1lVHJhbnNsYXRlZH0nYCk7XG4gICAgcmV0dXJuIGRldmljZU5hbWVUcmFuc2xhdGVkO1xuICB9XG4gIHJldHVybiBkZXZpY2VOYW1lO1xufVxuXG4vLyBUaGlzIG1hcCBjb250YWlucyBkZXJpdmVkIGRhdGEgbG9ncyBmb2xkZXJzIGFzIGtleXNcbi8vIGFuZCB2YWx1ZXMgYXJlIHRoZSBjb3VudCBvZiB0aW1lcyB0aGUgcGFydGljdWxhclxuLy8gZm9sZGVyIGhhcyBiZWVuIHNjaGVkdWxlZCBmb3IgcmVtb3ZhbFxuY29uc3QgZGVyaXZlZERhdGFDbGVhbnVwTWFya2VycyA9IG5ldyBNYXAoKTtcblxuYXN5bmMgZnVuY3Rpb24gbWFya1N5c3RlbUZpbGVzRm9yQ2xlYW51cCAod2RhKSB7XG4gIGlmICghd2RhIHx8ICFhd2FpdCB3ZGEucmV0cmlldmVEZXJpdmVkRGF0YVBhdGgoKSkge1xuICAgIGxvZy53YXJuKCdObyBXZWJEcml2ZXJBZ2VudCBkZXJpdmVkIGRhdGEgYXZhaWxhYmxlLCBzbyB1bmFibGUgdG8gbWFyayBzeXN0ZW0gZmlsZXMgZm9yIGNsZWFudXAnKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBsb2dzUm9vdCA9IHBhdGgucmVzb2x2ZShhd2FpdCB3ZGEucmV0cmlldmVEZXJpdmVkRGF0YVBhdGgoKSwgJ0xvZ3MnKTtcbiAgbGV0IG1hcmtlcnNDb3VudCA9IDA7XG4gIGlmIChkZXJpdmVkRGF0YUNsZWFudXBNYXJrZXJzLmhhcyhsb2dzUm9vdCkpIHtcbiAgICBtYXJrZXJzQ291bnQgPSBkZXJpdmVkRGF0YUNsZWFudXBNYXJrZXJzLmdldChsb2dzUm9vdCk7XG4gIH1cbiAgZGVyaXZlZERhdGFDbGVhbnVwTWFya2Vycy5zZXQobG9nc1Jvb3QsICsrbWFya2Vyc0NvdW50KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY2xlYXJTeXN0ZW1GaWxlcyAod2RhKSB7XG4gIC8vIG9ubHkgd2FudCB0byBjbGVhciB0aGUgc3lzdGVtIGZpbGVzIGZvciB0aGUgcGFydGljdWxhciBXREEgeGNvZGUgcnVuXG4gIGlmICghd2RhIHx8ICFhd2FpdCB3ZGEucmV0cmlldmVEZXJpdmVkRGF0YVBhdGgoKSkge1xuICAgIGxvZy53YXJuKCdObyBXZWJEcml2ZXJBZ2VudCBkZXJpdmVkIGRhdGEgYXZhaWxhYmxlLCBzbyB1bmFibGUgdG8gY2xlYXIgc3lzdGVtIGZpbGVzJyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgbG9nc1Jvb3QgPSBwYXRoLnJlc29sdmUoYXdhaXQgd2RhLnJldHJpZXZlRGVyaXZlZERhdGFQYXRoKCksICdMb2dzJyk7XG4gIGlmIChkZXJpdmVkRGF0YUNsZWFudXBNYXJrZXJzLmhhcyhsb2dzUm9vdCkpIHtcbiAgICBsZXQgbWFya2Vyc0NvdW50ID0gZGVyaXZlZERhdGFDbGVhbnVwTWFya2Vycy5nZXQobG9nc1Jvb3QpO1xuICAgIGRlcml2ZWREYXRhQ2xlYW51cE1hcmtlcnMuc2V0KGxvZ3NSb290LCAtLW1hcmtlcnNDb3VudCk7XG4gICAgaWYgKG1hcmtlcnNDb3VudCA+IDApIHtcbiAgICAgIGxvZy5pbmZvKGBOb3QgY2xlYW5pbmcgJyR7bG9nc1Jvb3R9JyBmb2xkZXIsIGJlY2F1c2UgdGhlIG90aGVyIHNlc3Npb24gZG9lcyBub3QgZXhwZWN0IGl0IHRvIGJlIGNsZWFuZWRgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgZGVyaXZlZERhdGFDbGVhbnVwTWFya2Vycy5zZXQobG9nc1Jvb3QsIDApO1xuXG4gIC8vIENsZWFuaW5nIHVwIGJpZyB0ZW1wb3JhcnkgZmlsZXMgY3JlYXRlZCBieSBYQ1Rlc3Q6IGh0dHBzOi8vZ2l0aHViLmNvbS9hcHBpdW0vYXBwaXVtL2lzc3Vlcy85NDEwXG4gIGNvbnN0IGNsZWFudXBDbWQgPSBgZmluZCAtRSAvcHJpdmF0ZS92YXIvZm9sZGVycyBgICtcbiAgICBgLXJlZ2V4ICcuKi9TZXNzaW9uLVdlYkRyaXZlckFnZW50UnVubmVyLipcXFxcLmxvZyR8LiovU3RhbmRhcmRPdXRwdXRBbmRTdGFuZGFyZEVycm9yXFxcXC50eHQkJyBgICtcbiAgICBgLXR5cGUgZiAtZXhlYyBzaCAtYyAnZWNobyBcIlwiID4gXCJ7fVwiJyBcXFxcO2A7XG4gIGNvbnN0IGNsZWFudXBUYXNrID0gbmV3IFN1YlByb2Nlc3MoJ2Jhc2gnLCBbJy1jJywgY2xlYW51cENtZF0sIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogWydpZ25vcmUnLCAncGlwZScsICdwaXBlJ10sXG4gIH0pO1xuICAvLyBEbyBub3Qgd2FpdCBmb3IgdGhlIHRhc2sgdG8gYmUgY29tcGxldGVkLCBzaW5jZSBpdCBtaWdodCB0YWtlIGEgbG90IG9mIHRpbWVcbiAgLy8gV2Uga2VlcCBpdCBydW5uaW5nIGFmdGVyIEFwcGl1bSBwcm9jZXNzIGlzIGtpbGxlZFxuICBhd2FpdCBjbGVhbnVwVGFzay5zdGFydCgwLCB0cnVlKTtcbiAgbG9nLmRlYnVnKGBTdGFydGVkIGJhY2tncm91bmQgWENUZXN0IGxvZ3MgY2xlYW51cDogJHtjbGVhbnVwQ21kfWApO1xuXG4gIGlmIChhd2FpdCBmcy5leGlzdHMobG9nc1Jvb3QpKSB7XG4gICAgbG9nLmluZm8oYENsZWFuaW5nIHRlc3QgbG9ncyBpbiAnJHtsb2dzUm9vdH0nIGZvbGRlcmApO1xuICAgIGF3YWl0IGlvc1V0aWxzLmNsZWFyTG9ncyhbbG9nc1Jvb3RdKTtcbiAgICByZXR1cm47XG4gIH1cbiAgbG9nLmluZm8oYFRoZXJlIGlzIG5vICR7bG9nc1Jvb3R9IGZvbGRlciwgc28gbm90IGNsZWFuaW5nIGZpbGVzYCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNoZWNrQXBwUHJlc2VudCAoYXBwKSB7XG4gIGxvZy5kZWJ1ZyhgQ2hlY2tpbmcgd2hldGhlciBhcHAgJyR7YXBwfScgaXMgYWN0dWFsbHkgcHJlc2VudCBvbiBmaWxlIHN5c3RlbWApO1xuICBpZiAoIShhd2FpdCBmcy5leGlzdHMoYXBwKSkpIHtcbiAgICBsb2cuZXJyb3JBbmRUaHJvdyhgQ291bGQgbm90IGZpbmQgYXBwIGF0ICcke2FwcH0nYCk7XG4gIH1cbiAgbG9nLmRlYnVnKCdBcHAgaXMgcHJlc2VudCcpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXREcml2ZXJJbmZvICgpIHtcbiAgY29uc3Qgc3RhdCA9IGF3YWl0IGZzLnN0YXQocGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4uJykpO1xuICBjb25zdCBidWlsdCA9IHN0YXQubXRpbWUuZ2V0VGltZSgpO1xuXG4gIC8vIGdldCB0aGUgcGFja2FnZS5qc29uIGFuZCB0aGUgdmVyc2lvbiBmcm9tIGl0XG4gIGNvbnN0IHBrZyA9IHJlcXVpcmUoX19maWxlbmFtZS5pbmNsdWRlcygnYnVpbGQvbGliL3V0aWxzJykgPyAnLi4vLi4vcGFja2FnZS5qc29uJyA6ICcuLi9wYWNrYWdlLmpzb24nKTtcbiAgY29uc3QgdmVyc2lvbiA9IHBrZy52ZXJzaW9uO1xuXG4gIHJldHVybiB7XG4gICAgYnVpbHQsXG4gICAgdmVyc2lvbixcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29tbWFuZFRpbWVvdXRzICh2YWx1ZSkge1xuICAvLyBUaGUgdmFsdWUgaXMgbm9ybWFsaXplZCBhbHJlYWR5XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG5cbiAgbGV0IHJlc3VsdCA9IHt9O1xuICAvLyBVc2UgYXMgZGVmYXVsdCB0aW1lb3V0IGZvciBhbGwgY29tbWFuZHMgaWYgYSBzaW5nbGUgaW50ZWdlciB2YWx1ZSBpcyBwcm92aWRlZFxuICBpZiAoIWlzTmFOKHZhbHVlKSkge1xuICAgIHJlc3VsdFtERUZBVUxUX1RJTUVPVVRfS0VZXSA9IF8udG9JbnRlZ2VyKHZhbHVlKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8gSlNPTiBvYmplY3QgaGFzIGJlZW4gcHJvdmlkZWQuIExldCdzIHBhcnNlIGl0XG4gIHRyeSB7XG4gICAgcmVzdWx0ID0gSlNPTi5wYXJzZSh2YWx1ZSk7XG4gICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVzdWx0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2cuZXJyb3JBbmRUaHJvdyhgXCJjb21tYW5kVGltZW91dHNcIiBjYXBhYmlsaXR5IHNob3VsZCBiZSBhIHZhbGlkIEpTT04gb2JqZWN0LiBcIiR7dmFsdWV9XCIgd2FzIGdpdmVuIGluc3RlYWRgKTtcbiAgfVxuICBmb3IgKGxldCBbY21kLCB0aW1lb3V0XSBvZiBfLnRvUGFpcnMocmVzdWx0KSkge1xuICAgIGlmICghXy5pc0ludGVnZXIodGltZW91dCkgfHwgdGltZW91dCA8PSAwKSB7XG4gICAgICBsb2cuZXJyb3JBbmRUaHJvdyhgVGhlIHRpbWVvdXQgZm9yIFwiJHtjbWR9XCIgc2hvdWxkIGJlIGEgdmFsaWQgbmF0dXJhbCBudW1iZXIgb2YgbWlsbGlzZWNvbmRzLiBcIiR7dGltZW91dH1cIiB3YXMgZ2l2ZW4gaW5zdGVhZGApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEB0eXBlZGVmIHtPYmplY3R9IFBpZExvb2t1cE9wdGlvbnNcbiAqXG4gKiBAcHJvcGVydHkgez9ib29sZWFufSBtdWx0aSBbZmFsc2VdIC0gU2V0IGl0IHRvIHRydWUgaWYgbXVsdGlwbGUgbWF0Y2hpbmdcbiAqIHBpZHMgYXJlIGV4cGVjdGVkIHRvIGJlIGZvdW5kLiBPbmx5IHRoZSBuZXdlc3QgcHJvY2VzcyBpZCBpcyBnb2luZyB0b1xuICogYmUgcmV0dXJuZWQgaW5zdGVhZFxuICogQHByb3BlcnR5IHs/Ym9vbGVhbn0gaWdub3JlQ2FzZSBbdHJ1ZV0gLSBTZXQgaXQgdG8gZmFsc2UgdG8gbWFrZSB0aGUgc2VhcmNoXG4gKiBjYXNlLXNlbnNpdGl2ZVxuICovXG5cbi8qKlxuICogR2V0IHRoZSBwcm9jZXNzIGlkIG9mIHRoZSBtb3N0IHJlY2VudCBydW5uaW5nIGFwcGxpY2F0aW9uXG4gKiBoYXZpbmcgdGhlIHBhcnRpY3VsYXIgY29tbWFuZCBsaW5lIHBhdHRlcm4uXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHBhdHRlcm4gLSBwZ3JlcC1jb21wYXRpYmxlIHNlYXJjaCBwYXR0ZXJuLlxuICogQHBhcmFtIHs/UGlkTG9va3VwT3B0aW9uc30gb3B0c1xuICogQHJldHVybiB7P3N0cmluZ3xBcnJheTxzdHJpbmc+fSBFaXRoZXIgYSBwcm9jZXNzIGlkIG9yIG51bGwgaWYgbm8gbWF0Y2hlcyB3ZXJlIGZvdW5kLlxuICogQW4gYXJyYXkgb2Ygc3RyaW5ncyBpcyBnb2luZyB0byBiZSByZXR1cm5lZCBpZiBgb3B0cy5tdWx0aWAgaXMgc2V0IHRvIHRydWVcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZ2V0UElEc1VzaW5nUGF0dGVybiAocGF0dGVybiwgb3B0cyA9IHt9KSB7XG4gIGNvbnN0IHtcbiAgICBtdWx0aSA9IGZhbHNlLFxuICAgIGlnbm9yZUNhc2UgPSB0cnVlLFxuICB9ID0gb3B0cztcbiAgY29uc3QgYXJncyA9IFtgLSR7aWdub3JlQ2FzZSA/ICdpJyA6ICcnfWYke211bHRpID8gJycgOiAnbid9YCwgcGF0dGVybl07XG4gIHRyeSB7XG4gICAgY29uc3Qge3N0ZG91dH0gPSBhd2FpdCBleGVjKCdwZ3JlcCcsIGFyZ3MpO1xuICAgIGlmIChtdWx0aSkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gc3Rkb3V0LnNwbGl0KCdcXG4nKVxuICAgICAgICAuZmlsdGVyKCh4KSA9PiBwYXJzZUludCh4LCAxMCkpXG4gICAgICAgIC5tYXAoKHgpID0+IGAke3BhcnNlSW50KHgsIDEwKX1gKTtcbiAgICAgIHJldHVybiBfLmlzRW1wdHkocmVzdWx0KSA/IG51bGwgOiByZXN1bHQ7XG4gICAgfVxuICAgIGNvbnN0IHBpZCA9IHBhcnNlSW50KHN0ZG91dCwgMTApO1xuICAgIHJldHVybiBpc05hTihwaWQpID8gbnVsbCA6IGAke3BpZH1gO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2cuZGVidWcoYCdwZ3JlcCAke2FyZ3Muam9pbignICcpfScgZGlkbid0IGRldGVjdCBhbnkgbWF0Y2hpbmcgcHJvY2Vzc2VzLiBSZXR1cm4gY29kZTogJHtlcnIuY29kZX1gKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vKipcbiAqIEtpbGwgYSBwcm9jZXNzIGhhdmluZyB0aGUgcGFydGljdWxhciBjb21tYW5kIGxpbmUgcGF0dGVybi5cbiAqIFRoaXMgbWV0aG9kIHRyaWVzIHRvIHNlbmQgU0lHSU5ULCBTSUdURVJNIGFuZCBTSUdLSUxMIHRvIHRoZVxuICogbWF0Y2hlZCBwcm9jZXNzZXMgaW4gdGhpcyBvcmRlciBpZiB0aGUgcHJvY2VzcyBpcyBzdGlsbCBydW5uaW5nLlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfSBwZ3JlcFBhdHRlcm4gLSBwZ3JlcC1jb21wYXRpYmxlIHNlYXJjaCBwYXR0ZXJuLlxuICovXG5hc3luYyBmdW5jdGlvbiBraWxsQXBwVXNpbmdQYXR0ZXJuIChwZ3JlcFBhdHRlcm4pIHtcbiAgZm9yIChjb25zdCBzaWduYWwgb2YgWzIsIDE1LCA5XSkge1xuICAgIGlmICghYXdhaXQgZ2V0UElEc1VzaW5nUGF0dGVybihwZ3JlcFBhdHRlcm4pKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGFyZ3MgPSBbYC0ke3NpZ25hbH1gLCAnLWlmJywgcGdyZXBQYXR0ZXJuXTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZXhlYygncGtpbGwnLCBhcmdzKTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGxvZy5kZWJ1ZyhgcGtpbGwgJHthcmdzLmpvaW4oJyAnKX0gLT4gJHtlcnIubWVzc2FnZX1gKTtcbiAgICB9XG4gICAgYXdhaXQgQi5kZWxheSgxMDApO1xuICB9XG59XG5cbi8qKlxuICogS2lsbHMgcnVubmluZyBYQ1Rlc3QgcHJvY2Vzc2VzIGZvciB0aGUgcGFydGljdWxhciBkZXZpY2UuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IHVkaWQgLSBUaGUgZGV2aWNlIFVESUQuXG4gKiBAcGFyYW0ge2Jvb2xlYW59IGlzU2ltdWxhdG9yIC0gRXF1YWxzIHRvIHRydWUgaWYgdGhlIGN1cnJlbnQgZGV2aWNlIGlzIGEgU2ltdWxhdG9yXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlc2V0WENUZXN0UHJvY2Vzc2VzICh1ZGlkLCBpc1NpbXVsYXRvcikge1xuICBjb25zdCBwcm9jZXNzUGF0dGVybnMgPSBbYHhjb2RlYnVpbGQuKiR7dWRpZH1gXTtcbiAgaWYgKGlzU2ltdWxhdG9yKSB7XG4gICAgcHJvY2Vzc1BhdHRlcm5zLnB1c2goYCR7dWRpZH0uKlhDVFJ1bm5lcmApO1xuICB9XG4gIGxvZy5kZWJ1ZyhgS2lsbGluZyBydW5uaW5nIHByb2Nlc3NlcyAnJHtwcm9jZXNzUGF0dGVybnMuam9pbignLCAnKX0nIGZvciB0aGUgZGV2aWNlICR7dWRpZH0uLi5gKTtcbiAgZm9yIChjb25zdCBwZ3JlcFBhdHRlcm4gb2YgcHJvY2Vzc1BhdHRlcm5zKSB7XG4gICAgYXdhaXQga2lsbEFwcFVzaW5nUGF0dGVybihwZ3JlcFBhdHRlcm4pO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHByaW50VXNlciAoKSB7XG4gIHRyeSB7XG4gICAgbGV0IHtzdGRvdXR9ID0gYXdhaXQgZXhlYygnd2hvYW1pJyk7XG4gICAgbG9nLmRlYnVnKGBDdXJyZW50IHVzZXI6ICcke3N0ZG91dC50cmltKCl9J2ApO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2cuZGVidWcoYFVuYWJsZSB0byBnZXQgdXNlcm5hbWUgcnVubmluZyBzZXJ2ZXI6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gIH1cbn1cblxuLyoqXG4gKiBHZXQgdGhlIElEcyBvZiBwcm9jZXNzZXMgbGlzdGVuaW5nIG9uIHRoZSBwYXJ0aWN1bGFyIHN5c3RlbSBwb3J0LlxuICogSXQgaXMgYWxzbyBwb3NzaWJsZSB0byBhcHBseSBhZGRpdGlvbmFsIGZpbHRlcmluZyBiYXNlZCBvbiB0aGVcbiAqIHByb2Nlc3MgY29tbWFuZCBsaW5lLlxuICpcbiAqIEBwYXJhbSB7c3RyaW5nfG51bWJlcn0gcG9ydCAtIFRoZSBwb3J0IG51bWJlci5cbiAqIEBwYXJhbSB7P0Z1bmN0aW9ufSBmaWx0ZXJpbmdGdW5jIC0gT3B0aW9uYWwgbGFtYmRhIGZ1bmN0aW9uLCB3aGljaFxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNlaXZlcyBjb21tYW5kIGxpbmUgc3RyaW5nIG9mIHRoZSBwYXJ0aWN1bGFyIHByb2Nlc3NcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbGlzdGVuaW5nIG9uIGdpdmVuIHBvcnQsIGFuZCBpcyBleHBlY3RlZCB0byByZXR1cm5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZWl0aGVyIHRydWUgb3IgZmFsc2UgdG8gaW5jbHVkZS9leGNsdWRlIHRoZSBjb3JyZXNwb25kaW5nIFBJRFxuICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmcm9tIHRoZSByZXN1bHRpbmcgYXJyYXkuXG4gKiBAcmV0dXJucyB7QXJyYXk8c3RyaW5nPn0gLSB0aGUgbGlzdCBvZiBtYXRjaGVkIHByb2Nlc3MgaWRzLlxuICovXG5hc3luYyBmdW5jdGlvbiBnZXRQSURzTGlzdGVuaW5nT25Qb3J0IChwb3J0LCBmaWx0ZXJpbmdGdW5jID0gbnVsbCkge1xuICBjb25zdCByZXN1bHQgPSBbXTtcbiAgdHJ5IHtcbiAgICAvLyBUaGlzIG9ubHkgd29ya3Mgc2luY2UgTWFjIE9TIFggRWwgQ2FwaXRhblxuICAgIGNvbnN0IHtzdGRvdXR9ID0gYXdhaXQgZXhlYygnbHNvZicsIFsnLXRpJywgYHRjcDoke3BvcnR9YF0pO1xuICAgIHJlc3VsdC5wdXNoKC4uLihzdGRvdXQudHJpbSgpLnNwbGl0KC9cXG4rLykpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBpZiAoIV8uaXNGdW5jdGlvbihmaWx0ZXJpbmdGdW5jKSkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cbiAgcmV0dXJuIGF3YWl0IEIuZmlsdGVyKHJlc3VsdCwgYXN5bmMgKHgpID0+IHtcbiAgICBjb25zdCB7c3Rkb3V0fSA9IGF3YWl0IGV4ZWMoJ3BzJywgWyctcCcsIHgsICctbycsICdjb21tYW5kJ10pO1xuICAgIHJldHVybiBhd2FpdCBmaWx0ZXJpbmdGdW5jKHN0ZG91dCk7XG4gIH0pO1xufVxuXG4vKipcbiAqIEB0eXBlZGVmIHtPYmplY3R9IFVwbG9hZE9wdGlvbnNcbiAqXG4gKiBAcHJvcGVydHkgez9zdHJpbmd9IHVzZXIgLSBUaGUgbmFtZSBvZiB0aGUgdXNlciBmb3IgdGhlIHJlbW90ZSBhdXRoZW50aWNhdGlvbi4gT25seSB3b3JrcyBpZiBgcmVtb3RlUGF0aGAgaXMgcHJvdmlkZWQuXG4gKiBAcHJvcGVydHkgez9zdHJpbmd9IHBhc3MgLSBUaGUgcGFzc3dvcmQgZm9yIHRoZSByZW1vdGUgYXV0aGVudGljYXRpb24uIE9ubHkgd29ya3MgaWYgYHJlbW90ZVBhdGhgIGlzIHByb3ZpZGVkLlxuICogQHByb3BlcnR5IHs/c3RyaW5nfSBtZXRob2QgLSBUaGUgaHR0cCBtdWx0aXBhcnQgdXBsb2FkIG1ldGhvZCBuYW1lLiBUaGUgJ1BVVCcgb25lIGlzIHVzZWQgYnkgZGVmYXVsdC5cbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgT25seSB3b3JrcyBpZiBgcmVtb3RlUGF0aGAgaXMgcHJvdmlkZWQuXG4gKi9cblxuXG4vKipcbiAqIEVuY29kZXMgdGhlIGdpdmVuIGxvY2FsIGZpbGUgdG8gYmFzZTY0IGFuZCByZXR1cm5zIHRoZSByZXN1bHRpbmcgc3RyaW5nXG4gKiBvciB1cGxvYWRzIGl0IHRvIGEgcmVtb3RlIHNlcnZlciB1c2luZyBodHRwL2h0dHBzIG9yIGZ0cCBwcm90b2NvbHNcbiAqIGlmIGByZW1vdGVQYXRoYCBpcyBzZXRcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gbG9jYWxGaWxlIC0gVGhlIHBhdGggdG8gYW4gZXhpc3RpbmcgbG9jYWwgZmlsZVxuICogQHBhcmFtIHs/c3RyaW5nfSByZW1vdGVQYXRoIC0gVGhlIHBhdGggdG8gdGhlIHJlbW90ZSBsb2NhdGlvbiwgd2hlcmVcbiAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMgZmlsZSBzaG91bGQgYmUgdXBsb2FkZWRcbiAqIEBwYXJhbSB7P1VwbG9hZE9wdGlvbnN9IHVwbG9hZE9wdGlvbnMgLSBTZXQgb2YgdXBsb2FkIG9wdGlvbnNcbiAqIEByZXR1cm5zIHtzdHJpbmd9IEVpdGhlciBhbiBlbXB0eSBzdHJpbmcgaWYgdGhlIHVwbG9hZCB3YXMgc3VjY2Vzc2Z1bCBvclxuICogYmFzZTY0LWVuY29kZWQgZmlsZSByZXByZXNlbnRhdGlvbiBpZiBgcmVtb3RlUGF0aGAgaXMgZmFsc3lcbiAqL1xuYXN5bmMgZnVuY3Rpb24gZW5jb2RlQmFzZTY0T3JVcGxvYWQgKGxvY2FsRmlsZSwgcmVtb3RlUGF0aCA9IG51bGwsIHVwbG9hZE9wdGlvbnMgPSB7fSkge1xuICBpZiAoIWF3YWl0IGZzLmV4aXN0cyhsb2NhbEZpbGUpKSB7XG4gICAgbG9nLmVycm9yQW5kVGhyb3coYFRoZSBmaWxlIGF0ICcke2xvY2FsRmlsZX0nIGRvZXMgbm90IGV4aXN0IG9yIGlzIG5vdCBhY2Nlc3NpYmxlYCk7XG4gIH1cblxuICBjb25zdCB7c2l6ZX0gPSBhd2FpdCBmcy5zdGF0KGxvY2FsRmlsZSk7XG4gIGxvZy5kZWJ1ZyhgVGhlIHNpemUgb2YgdGhlIGZpbGUgaXMgJHt1dGlsLnRvUmVhZGFibGVTaXplU3RyaW5nKHNpemUpfWApO1xuICBpZiAoXy5pc0VtcHR5KHJlbW90ZVBhdGgpKSB7XG4gICAgY29uc3QgbWF4TWVtb3J5TGltaXQgPSB2OC5nZXRIZWFwU3RhdGlzdGljcygpLnRvdGFsX2F2YWlsYWJsZV9zaXplIC8gMjtcbiAgICBpZiAoc2l6ZSA+PSBtYXhNZW1vcnlMaW1pdCkge1xuICAgICAgbG9nLmluZm8oYFRoZSBmaWxlIG1pZ2h0IGJlIHRvbyBsYXJnZSB0byBmaXQgaW50byB0aGUgcHJvY2VzcyBtZW1vcnkgYCArXG4gICAgICAgIGAoJHt1dGlsLnRvUmVhZGFibGVTaXplU3RyaW5nKHNpemUpfSA+PSAke3V0aWwudG9SZWFkYWJsZVNpemVTdHJpbmcobWF4TWVtb3J5TGltaXQpfSkuIGAgK1xuICAgICAgICBgUHJvdmlkZSBhIGxpbmsgdG8gYSByZW1vdGUgd3JpdGFibGUgbG9jYXRpb24gZm9yIHZpZGVvIHVwbG9hZCBgICtcbiAgICAgICAgYChodHRwKHMpIGFuZCBmdHAgcHJvdG9jb2xzIGFyZSBzdXBwb3J0ZWQpIGlmIHlvdSBleHBlcmllbmNlIE91dCBPZiBNZW1vcnkgZXJyb3JzYCk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRlbnQgPSBhd2FpdCBmcy5yZWFkRmlsZShsb2NhbEZpbGUpO1xuICAgIHJldHVybiBjb250ZW50LnRvU3RyaW5nKCdiYXNlNjQnKTtcbiAgfVxuXG4gIGNvbnN0IHJlbW90ZVVybCA9IHVybC5wYXJzZShyZW1vdGVQYXRoKTtcbiAgbGV0IG9wdGlvbnMgPSB7fTtcbiAgY29uc3Qge3VzZXIsIHBhc3MsIG1ldGhvZH0gPSB1cGxvYWRPcHRpb25zO1xuICBpZiAocmVtb3RlVXJsLnByb3RvY29sLnN0YXJ0c1dpdGgoJ2h0dHAnKSkge1xuICAgIG9wdGlvbnMgPSB7XG4gICAgICB1cmw6IHJlbW90ZVVybC5ocmVmLFxuICAgICAgbWV0aG9kOiBtZXRob2QgfHwgJ1BVVCcsXG4gICAgICBtdWx0aXBhcnQ6IFt7IGJvZHk6IF9mcy5jcmVhdGVSZWFkU3RyZWFtKGxvY2FsRmlsZSkgfV0sXG4gICAgfTtcbiAgICBpZiAodXNlciAmJiBwYXNzKSB7XG4gICAgICBvcHRpb25zLmF1dGggPSB7dXNlciwgcGFzc307XG4gICAgfVxuICB9IGVsc2UgaWYgKHJlbW90ZVVybC5wcm90b2NvbCA9PT0gJ2Z0cDonKSB7XG4gICAgb3B0aW9ucyA9IHtcbiAgICAgIGhvc3Q6IHJlbW90ZVVybC5ob3N0bmFtZSxcbiAgICAgIHBvcnQ6IHJlbW90ZVVybC5wb3J0IHx8IDIxLFxuICAgIH07XG4gICAgaWYgKHVzZXIgJiYgcGFzcykge1xuICAgICAgb3B0aW9ucy51c2VyID0gdXNlcjtcbiAgICAgIG9wdGlvbnMucGFzcyA9IHBhc3M7XG4gICAgfVxuICB9XG4gIGF3YWl0IG5ldC51cGxvYWRGaWxlKGxvY2FsRmlsZSwgcmVtb3RlUGF0aCwgb3B0aW9ucyk7XG4gIHJldHVybiAnJztcbn1cblxuLyoqXG4gKiBTdG9wcyBhbmQgcmVtb3ZlcyBhbGwgd2ViIHNvY2tldCBoYW5kbGVycyB0aGF0IGFyZSBsaXN0ZW5pbmdcbiAqIGluIHNjb3BlIG9mIHRoZSBjdXJyZWN0IHNlc3Npb24uXG4gKlxuICogQHBhcmFtIHtPYmplY3R9IHNlcnZlciAtIFRoZSBpbnN0YW5jZSBvZiBOb2RlSnMgSFRUUCBzZXJ2ZXIsXG4gKiB3aGljaCBob3N0cyBBcHBpdW1cbiAqIEBwYXJhbSB7c3RyaW5nfSBzZXNzaW9uSWQgLSBUaGUgaWQgb2YgdGhlIGN1cnJlbnQgc2Vzc2lvblxuICovXG5hc3luYyBmdW5jdGlvbiByZW1vdmVBbGxTZXNzaW9uV2ViU29ja2V0SGFuZGxlcnMgKHNlcnZlciwgc2Vzc2lvbklkKSB7XG4gIGlmICghc2VydmVyIHx8ICFfLmlzRnVuY3Rpb24oc2VydmVyLmdldFdlYlNvY2tldEhhbmRsZXJzKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGFjdGl2ZUhhbmRsZXJzID0gYXdhaXQgc2VydmVyLmdldFdlYlNvY2tldEhhbmRsZXJzKHNlc3Npb25JZCk7XG4gIGZvciAoY29uc3QgcGF0aG5hbWUgb2YgXy5rZXlzKGFjdGl2ZUhhbmRsZXJzKSkge1xuICAgIGF3YWl0IHNlcnZlci5yZW1vdmVXZWJTb2NrZXRIYW5kbGVyKHBhdGhuYW1lKTtcbiAgfVxufVxuXG4vKipcbiAqIFZlcmlmeSB3aGV0aGVyIHRoZSBnaXZlbiBhcHBsaWNhdGlvbiBpcyBjb21wYXRpYmxlIHRvIHRoZVxuICogcGxhdGZvcm0gd2hlcmUgaXQgaXMgZ29pbmcgdG8gYmUgaW5zdGFsbGVkIGFuZCB0ZXN0ZWQuXG4gKlxuICogQHBhcmFtIHtzdHJpbmd9IGFwcCAtIFRoZSBhY3R1YWwgcGF0aCB0byB0aGUgYXBwbGljYXRpb24gYnVuZGxlXG4gKiBAcGFyYW0ge2Jvb2xlYW59IGlzU2ltdWxhdG9yIC0gU2hvdWxkIGJlIHNldCB0byBgdHJ1ZWAgaWYgdGhlIHRlc3Qgd2lsbCBiZSBleGVjdXRlZCBvbiBTaW11bGF0b3JcbiAqIEByZXR1cm5zIHs/Ym9vbGVhbn0gVGhlIGZ1bmN0aW9uIHJldHVybnMgYG51bGxgIGlmIHRoZSBhcHBsaWNhdGlvbiBkb2VzIG5vdCBleGlzdCBvciB0aGVyZSBpcyBub1xuICogYENGQnVuZGxlU3VwcG9ydGVkUGxhdGZvcm1zYCBrZXkgaW4gaXRzIEluZm8ucGxpc3QgbWFuaWZlc3QuXG4gKiBgdHJ1ZWAgaXMgcmV0dXJuZWQgaWYgdGhlIGJ1bmRsZSBhcmNoaXRlY3R1cmUgbWF0Y2hlcyB0aGUgZGV2aWNlIGFyY2hpdGVjdHVyZS5cbiAqIEB0aHJvd3Mge0Vycm9yfSBJZiBidW5kbGUgYXJjaGl0ZWN0dXJlIGRvZXMgbm90IG1hdGNoIHRoZSBkZXZpY2UgYXJjaGl0ZWN0dXJlLlxuICovXG5hc3luYyBmdW5jdGlvbiB2ZXJpZnlBcHBsaWNhdGlvblBsYXRmb3JtIChhcHAsIGlzU2ltdWxhdG9yLCBpc1R2T1MpIHtcbiAgbG9nLmRlYnVnKCdWZXJpZnlpbmcgYXBwbGljYXRpb24gcGxhdGZvcm0nKTtcblxuICBjb25zdCBpbmZvUGxpc3QgPSBwYXRoLnJlc29sdmUoYXBwLCAnSW5mby5wbGlzdCcpO1xuICBpZiAoIWF3YWl0IGZzLmV4aXN0cyhpbmZvUGxpc3QpKSB7XG4gICAgbG9nLmRlYnVnKGAnJHtpbmZvUGxpc3R9JyBkb2VzIG5vdCBleGlzdGApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3Qge0NGQnVuZGxlU3VwcG9ydGVkUGxhdGZvcm1zfSA9IGF3YWl0IHBsaXN0LnBhcnNlUGxpc3RGaWxlKGluZm9QbGlzdCk7XG4gIGxvZy5kZWJ1ZyhgQ0ZCdW5kbGVTdXBwb3J0ZWRQbGF0Zm9ybXM6ICR7SlNPTi5zdHJpbmdpZnkoQ0ZCdW5kbGVTdXBwb3J0ZWRQbGF0Zm9ybXMpfWApO1xuICBpZiAoIV8uaXNBcnJheShDRkJ1bmRsZVN1cHBvcnRlZFBsYXRmb3JtcykpIHtcbiAgICBsb2cuZGVidWcoYENGQnVuZGxlU3VwcG9ydGVkUGxhdGZvcm1zIGtleSBkb2VzIG5vdCBleGlzdCBpbiAnJHtpbmZvUGxpc3R9J2ApO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgZXhwZWN0ZWRQbGF0Zm9ybSA9IGlzU2ltdWxhdG9yXG4gICAgPyBpc1R2T1MgPyAnQXBwbGVUVlNpbXVsYXRvcicgOiAnaVBob25lU2ltdWxhdG9yJ1xuICAgIDogaXNUdk9TID8gJ0FwcGxlVFZPUycgOiAnaVBob25lT1MnO1xuXG4gIGNvbnN0IGlzQXBwU3VwcG9ydGVkID0gQ0ZCdW5kbGVTdXBwb3J0ZWRQbGF0Zm9ybXMuaW5jbHVkZXMoZXhwZWN0ZWRQbGF0Zm9ybSk7XG4gIGlmIChpc0FwcFN1cHBvcnRlZCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihgJHtpc1NpbXVsYXRvciA/ICdTaW11bGF0b3InIDogJ1JlYWwgZGV2aWNlJ30gYXJjaGl0ZWN0dXJlIGlzIHVuc3VwcG9ydGVkIGJ5IHRoZSAnJHthcHB9JyBhcHBsaWNhdGlvbi4gYCArXG4gICAgICAgICAgICAgICAgICBgTWFrZSBzdXJlIHRoZSBjb3JyZWN0IGRlcGxveW1lbnQgdGFyZ2V0IGhhcyBiZWVuIHNlbGVjdGVkIGZvciBpdHMgY29tcGlsYXRpb24gaW4gWGNvZGUuYCk7XG59XG5cbi8qKlxuICogUmV0dXJuIHRydWUgaWYgdGhlIHBsYXRmb3JtTmFtZSBpcyB0dk9TXG4gKiBAcGFyYW0ge3N0cmluZ30gcGxhdGZvcm1OYW1lIFRoZSBuYW1lIG9mIHRoZSBwbGF0b3JtXG4gKiBAcmV0dXJucyB7Ym9vbGVhbn0gUmV0dXJuIHRydWUgaWYgdGhlIHBsYXRmb3JtTmFtZSBpcyB0dk9TXG4gKi9cbmZ1bmN0aW9uIGlzVHZPUyAocGxhdGZvcm1OYW1lKSB7XG4gIHJldHVybiBfLnRvTG93ZXIocGxhdGZvcm1OYW1lKSA9PT0gXy50b0xvd2VyKFBMQVRGT1JNX05BTUVfVFZPUyk7XG59XG5cbi8qKlxuICogUmV0dXJucyB0cnVlIGlmIHRoZSB1cmxTdHJpbmcgaXMgbG9jYWxob3N0XG4gKiBAcGFyYW0gez9zdHJpbmd9IHVybFN0cmluZ1xuICogQHJldHVybnMge2Jvb2xlYW59IFJldHVybiB0cnVlIGlmIHRoZSB1cmxTdHJpbmcgaXMgbG9jYWxob3N0XG4gKi9cbmZ1bmN0aW9uIGlzTG9jYWxIb3N0ICh1cmxTdHJpbmcpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7aG9zdG5hbWV9ID0gdXJsLnBhcnNlKHVybFN0cmluZyk7XG4gICAgcmV0dXJuIFsnbG9jYWxob3N0JywgJzEyNy4wLjAuMScsICc6OjEnLCAnOjpmZmZmOjEyNy4wLjAuMSddLmluY2x1ZGVzKGhvc3RuYW1lKTtcbiAgfSBjYXRjaCAoaWduKSB7XG4gICAgbG9nLndhcm4oYCcke3VybFN0cmluZ30nIGNhbm5vdCBiZSBwYXJzZWQgYXMgYSB2YWxpZCBVUkxgKTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogTm9ybWFsaXplcyBwbGF0Zm9ybVZlcnNpb24gdG8gYSB2YWxpZCBpT1MgdmVyc2lvbiBzdHJpbmdcbiAqXG4gKiBAcGFyYW0ge3N0cmluZ30gb3JpZ2luYWxWZXJzaW9uIC0gTG9vc2UgdmVyc2lvbiBudW1iZXIsIHRoYXQgY2FuIGJlIHBhcnNlZCBieSBzZW12ZXJcbiAqIEByZXR1cm4ge3N0cmluZ30gaU9TIHZlcnNpb24gbnVtYmVyIGluIDxtYWpvcj4uPG1pbm9yPiBmb3JtYXRcbiAqIEB0aHJvd3Mge0Vycm9yfSBpZiB0aGUgdmVyc2lvbiBudW1iZXIgY2Fubm90IGJlIHBhcnNlZFxuICovXG5mdW5jdGlvbiBub3JtYWxpemVQbGF0Zm9ybVZlcnNpb24gKG9yaWdpbmFsVmVyc2lvbikge1xuICBjb25zdCBub3JtYWxpemVkVmVyc2lvbiA9IHV0aWwuY29lcmNlVmVyc2lvbihvcmlnaW5hbFZlcnNpb24sIGZhbHNlKTtcbiAgaWYgKCFub3JtYWxpemVkVmVyc2lvbikge1xuICAgIHRocm93IG5ldyBFcnJvcihgVGhlIHBsYXRmb3JtIHZlcnNpb24gJyR7b3JpZ2luYWxWZXJzaW9ufScgc2hvdWxkIGJlIGEgdmFsaWQgdmVyc2lvbiBudW1iZXJgKTtcbiAgfVxuICBjb25zdCB7bWFqb3IsIG1pbm9yfSA9IG5ldyBzZW12ZXIuU2VtVmVyKG5vcm1hbGl6ZWRWZXJzaW9uKTtcbiAgcmV0dXJuIGAke21ham9yfS4ke21pbm9yfWA7XG59XG5cbmV4cG9ydCB7IGRldGVjdFVkaWQsIGdldEFuZENoZWNrWGNvZGVWZXJzaW9uLCBnZXRBbmRDaGVja0lvc1Nka1ZlcnNpb24sXG4gIGNoZWNrQXBwUHJlc2VudCwgZ2V0RHJpdmVySW5mbyxcbiAgY2xlYXJTeXN0ZW1GaWxlcywgdHJhbnNsYXRlRGV2aWNlTmFtZSwgbm9ybWFsaXplQ29tbWFuZFRpbWVvdXRzLFxuICBERUZBVUxUX1RJTUVPVVRfS0VZLCByZXNldFhDVGVzdFByb2Nlc3NlcywgZ2V0UElEc1VzaW5nUGF0dGVybixcbiAgbWFya1N5c3RlbUZpbGVzRm9yQ2xlYW51cCwgcHJpbnRVc2VyLFxuICBnZXRQSURzTGlzdGVuaW5nT25Qb3J0LCBlbmNvZGVCYXNlNjRPclVwbG9hZCwgcmVtb3ZlQWxsU2Vzc2lvbldlYlNvY2tldEhhbmRsZXJzLFxuICB2ZXJpZnlBcHBsaWNhdGlvblBsYXRmb3JtLCBpc1R2T1MsIGlzTG9jYWxIb3N0LCBub3JtYWxpemVQbGF0Zm9ybVZlcnNpb24gfTtcbiJdLCJmaWxlIjoibGliL3V0aWxzLmpzIiwic291cmNlUm9vdCI6Ii4uLy4uIn0=
