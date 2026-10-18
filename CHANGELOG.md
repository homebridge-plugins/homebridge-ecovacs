# Change Log

All notable changes to `@homebridge-plugins/homebridge-ecovacs` will be documented in this file.

## v8.2.4 (2026-10-18)

### Changed

- chore(deps): dependency updates

## v8.2.3 (2026-08-21)

### Changed

- fix: refresh a matter vacuum on a timer, so a missed docking event stops leaving it on updating
- fix: say when a device id in the config matches nothing, instead of ignoring its settings in silence
- chore(deps): dependency updates

## v8.2.2 (2026-08-09)

### Changed

- chore: add a changelog:sync script to populate the pending section from the commits
- chore: count a repeated commit subject once when syncing the changelog
- chore(github): check the changelog against the commits in ci
- docs: add node 26 to the supported node versions
- chore: allow dependency install scripts by package name rather than pinned version, so a version bump cannot silently block a native build
- fix(deps): refresh brace-expansion to a patched version, clearing the high npm advisory
- fix(deps): force axios to a patched version under both deebot libraries, clearing eleven npm advisories
- chore: exclude test files and the test config from the published package
- fix: keep the ecovacs session through cloud blips and renew it before its weekly expiry (#306)
- fix: restore debug logging when the plugin runs in a child bridge
- fix: make the poll interval refresh the device, instead of restarting the bridge every tick
- fix: remove the true detect toggle from eve when the setting is turned off
- fix: put the go charge switch back when the vacuum is already charging
- fix: stop repeating the same device error on every command in matter mode
- fix: remove a listener for a device event that is never sent
- fix: reject a poll interval so large it would make the plugin poll every millisecond
- chore(deps): dependency updates

## v8.2.1 (2026-07-28)

### Changed

- fix: quieten the ecovacs library logging from within the plugin, instead of editing node_modules during install
- chore: add a test setup, and keep test files out of the published package
- chore(github): run the build and tests in ci, on node 22, 24 and 26
- chore(github): install with npm install in ci, as npm 10 cannot satisfy this lock file
- chore: use the same lint setup across every plugin

## v8.2.0 (2026-07-27)

### Changed

- chore(github): allow the codeql scan to be started manually
- chore(github): stop concurrent release runs racing for the same version
- chore: add the supports-matter keyword
- chore(github): use the shared homebridge action to deprecate past pre-releases
- feat(ui): add, remove and hide devices from the config via the my devices tab
- style(ui): standardise the custom ui layout and sync the support tab with the readme
- feat(ui): add a remove all devices action to the my devices tab
- fix(schema): declare required fields the standard way so the homebridge ui stops reporting a config validation failure
- chore: declare the supports-hap transport keyword for the homebridge ui
- chore(deps): dependency updates
- docs(changelog): list every unreleased commit in the pending section

## v8.1.4 (2026-07-19)

### Changed

- fix(deps): override the vendored xmpp client's outdated ws dependency to close a dos advisory

## v8.1.3 (2026-07-19)

### Changed

- fix: xmpp devices connect with the login client resource again, as ecovacs refuses any other resource on xmpp just as it does on mqtt

## v8.1.2 (2026-07-19)

### Changed

- fix: borrow the newer library's login session when ecovacs refuses the stable login (code 1013)
- feat: remember the ecovacs login session across restarts so verification is a one-time step
- fix: note the optional canvas module being unbuilt once at debug level instead of warning on every map event

## v8.1.1 (2026-07-19)

### Changed

- fix: retire the library version setting - the alpha library is now purely an internal detail of device verification

## v8.1.0 (2026-07-19)

⚠️ If installing fails on npm v12 with an `EALLOWREMOTE` error, see [#302](https://github.com/homebridge-plugins/homebridge-ecovacs/issues/302) for a one-line workaround.

### Changed

- feat: add a library version setting and complete ecovacs device verification automatically (code 1013)
- fix: keep the matter serial number within 32 characters for uuid-style device ids

## v8.0.4 (2026-07-19)

### Changed

- fix: mqtt devices connect with the login client resource again, as a custom one is refused with 'not authorized' and control is lost

## v8.0.3 (2026-07-19)

### Changed

- chore(deps): revert `ecovacs-deebot` package

## v8.0.2 (2026-07-18)

### Changed

- chore: remove the looking-for-maintainers message
- fix: give each vacuum its own client resource so multiple devices no longer mix up status updates (#81)
- chore(github): update the setup-node action to v7
- chore(deps): update dependencies
- chore(deps): dependency updates

## v8.0.1 (2026-07-12)

### Changed

- fix: do not force-load the Matter API, which made the plugin take the Matter path and disable itself on non-Matter bridges (#298) (#300)
- fix: retry the Ecovacs login on transient failures instead of disabling the plugin until a restart (#284)
- chore: update `actions/checkout` workflow action to v7
- chore: remove stray `exit 1` from the deprecation workflow script
- chore: dependency updates
- docs: correct the minimum Homebridge version in the readme to v2.0

## v8.0.0 (2026-05-04)

Many thanks to @tainguyen2512 for working on the Matter and Typescript integrations 🎉

### ⚠️ Breaking Changes

- Refactor device representation to align with HomeKit vacuum behavior
- Existing configurations may require re-setup in HomeKit

### Changes

- Add basic native HomeKit vacuum support for Ecovacs devices
- Expose vacuum functionality using HomeKit-compatible services
- Support core actions: start cleaning, stop, and return to dock
- Map Ecovacs device states to HomeKit characteristics
- Add basic battery status reporting

### 🛠 Improvements

- Improve state synchronization between Ecovacs API and HomeKit
- Enhance overall stability when controlling devices from HomeKit

### 🐛 Fixes

- Fix inconsistent state updates during cleaning cycles
- Fix issues with device responsiveness in certain scenarios

### 📌 Notes

- This is an initial implementation of native HomeKit vacuum support
- Additional features and refinements will be added in future releases

### Commits

- feat: add basic typescript/matter support
- docs: add `CLAUDE.md` file to repo

## v7.4.0 (2026-04-05)

### Changes

- dependency updates
- remove support for node v20
- fix: shallow copy default config/device objects
- fix: correct poll interval config access
- fix: remove extra brace in clean update log
- fix: move accessory null check before first use
- fix: clear cache after updateValue calls, not before
- fix: correct error message for predefined area failures
- fix: guard `refreshIntervals` in `pluginShutdown`
- fix: use logDebug for `GetChargeState` in `externalReadyUpdate`
- fix: use object over sparse array for virtual boundaries
- fix: remove unused `refreshTime` config
- fix: use `trim()` in `parseError` stack trace cleanup

## v7.3.0 (2026-02-16)

### Changes

- determine debug mode from `-D` flag
- updated dependencies
- updated dependencies + lint rules
- update workflow action versions
- fix deprecate past releases script

## v7.2.4 (2025-12-05)

### Changes

- update readme badges (use `shields.io`)
- update workflows and npm publish via oidc
- update dependencies

## v7.2.3 (2025-07-24)

### Other Changes

- dependency updates

## v7.2.2 (2025-07-18)

### Other Changes

- add maintainer message

## v7.2.1 (2025-07-16)

### Other Changes

- clear cache values on reset, fix go charge on

## v7.2.0 (2025-07-13)

### Notable Changes

- fix custom plugin config modal styles in ui 5
- fix custom characteristics for hb 2

### Other Changes

- add `lint` step to build workflow
- add permissions to workflows
- improvements to the deprecate workflow

## v7.1.0 (2025-07-12)

### Notable Changes

- set `strictValidation` to `true` in the config schema file

### Other Changes

- github repo maintenance

## v7.0.2 (2025-07-11)

### Changed

- fix `patch-package` command not present

## v7.0.1 (2025-07-11)

### Changed

- patch `evocavs-deebot` with a change to not log events when not in debug mode

## v7.0.0 (2025-07-11)

- Drop support for Node.js v16 and v18, add support for Node.js v20, v22, and v24

## v6.1.1 (2023-08-28)

⚠️ Note this will be the last version of the plugin to support Node 16.

- Node 16 moves to 'end of life' on 2023-09-11 ([more info](https://nodejs.org/en/blog/announcements/nodejs16-eol))
- This is in-line with the Homebridge guidelines on supporting node versions ([more info](https://github.com/homebridge/homebridge/wiki/How-To-Update-Node.js/))
- If you are currently using Node 16, now is a good time to upgrade to Node 18 or 20 (see the link above for more info)

### Changed

- Updated dependencies

## v6.1.0 (2023-08-10)

### Added

- Allow a polling interval to be set per accessory, or can be set to `0` to disable polling if the device supports push updates

### Changed

- Bump `ecovavs-deebot` library to v0.9.6-prerelease (thanks @mrbungle64!)
- Bump `node` recommended versions to v16.20.2 or v18.17.1 or v20.5.1

## v6.0.5 (2023-04-05)

## v6.0.4 (2023-04-05)

## v6.0.3 (2023-04-05)

### Changed

- Bump `ecovavs-deebot` library to v0.9.5 (thanks @mrbungle64!)
- Simplify log welcome messages

## v6.0.2 (2023-03-24)

### Changed

- Bump `ecovavs-deebot` library to v0.9.4 (thanks @mrbungle64!)

## v6.0.1 (2023-03-14)

### Fixed

- ` [GetNetInfo]` should be debug logging

## v6.0.0 (2023-03-11)

### Breaking

- Remove official support for Node 14
- Remove deprecated config options for old commands
- Remove option to disable plugin - this is now available in the Homebridge UI
- Remove option for debug logging - this will be enabled when using a beta version of the plugin
- Remove individual accessory logging options to simplify the config

### Changed

- Bump `ecovavs-deebot` library to v0.9.3 (thanks @mrbungle64!)
- Bump `node` recommended versions to v16.19.1 or v18.15.0

## v5.3.2 (2023-01-07)

### Changed

- Bump `ecovavs-deebot` library to v0.9.2 (pre-release)
- Bump `node` recommended versions to v14.21.2 or v16.19.0 or v18.13.0
- Bump `homebridge` recommended version to v1.6.0 or v2.0.0-beta

### Fixed

- Show correct service names for new accessories on new iOS version

## v5.3.1 (2022-11-27)

### Fixed

- A potential configuration issue when using multiple devices

## v5.3.0 (2022-11-24)

### Added

- Support for air drying (thanks [@apfelnutzer](https://github.com/apfelnutzer)!)
  - Switch can be hidden via the config if unwanted

### Changed

- Bump `ecovavs-deebot` library to v0.9.0
- Bump `node` recommended versions to v14.21.1 or v16.18.1 or v18.12.1

## v5.2.0 (2022-09-25)

### Added

- Support for cleaning coordinate areas (thanks [@apfelnutzer](https://github.com/apfelnutzer)!)

### Changed

- Correct parameters for `updatePlatformAccessories()`
- Existing custom areas have been renamed to Predefined Areas
- Bump `node` recommended versions to v14.20.1 or v16.17.1
- Updated dev dependencies

## v5.1.0 (2022-08-28)

### Added

- Updated `ecovacs-deebot` library to v0.8.3, notable changes:
  - Added initial support for yeedi login and also for a few models
    - yeedi k650
    - yeedi 2 hybrid
    - yeedi vac hybrid
    - yeedi mop station
    - Bumped canvas to 2.9.3

### Changed

- Bump `node` recommended versions to v14.20.0 or v16.17.0
- Bump `homebridge` recommended version to v1.5.0

## v5.0.5 (2022-06-08)

### Changed

- Bump `node` recommended versions to v14.19.3 or v16.15.1

### Fixed

- A potential issue showing errors in the logs

## v5.0.4 (2022-05-28)

### Changed

- More fixes and refactoring

## v5.0.3 (2022-05-28)

### Changed

- Bump `ecovacs-deebot` to v0.8.2

## v5.0.2 (2022-05-22)

### Changed

- Some refactoring

## v5.0.1 (2022-05-22)

### Changed

- Bump `node` recommended versions to v14.19.3 or v16.15.0
- Bump `ecovacs-deebot` to v0.8.1

## v5.0.0 (2022-05-07)

### Potentially Breaking Changes

⚠️ The minimum required version of Homebridge is now v1.4.0
⚠️ The minimum required version of Node is now v14

### Changed

- Changed to ESM package
- Bump `node` recommended versions to v14.19.1 or v16.14.2
- Bump `ecovacs-deebot` to v0.8.0

## v4.4.2 (2022-02-27)

### Changed

- Bump `node` recommended versions to v14.19.0 or v16.14.0
- Bump `homebridge` recommended version to v1.4.0
- Bump `ecovacs-deebot` to v0.7.2

## v4.4.1 (2022-01-15)

### Changed

- Bump `ecovacs-deebot` to v0.7.1
- Bump `node` recommended versions to v14.18.3 or v16.13.2

### Fixed

- Plugin crash for older versions of Homebridge

## v4.4.0 (2022-01-05)

### Added

- A further five custom areas bringing the total to fifteen

### Changed

- Plugin will log HAPNodeJS version on startup
- Bump `homebridge` recommended version to v1.3.9
- Updated dependencies

## v4.3.3 (2021-12-29)

### Changed

- Updated dependencies

## v4.3.2 (2021-12-26)

### Changed

- Updated dependencies

## v4.3.1 (2021-12-18)

### Added

- Accessory switches will show as 'No Response' until plugin has successfully initialised

### Changed

- Some config options rearranged for easier access
- More device info and device count logged on plugin initialisation
- Bump `ecovacs-deebot` to v0.7.0
- Bump `homebridge` recommended version to v1.3.8
- Bump `node` recommended versions to v14.18.2 or v16.13.1

## v4.2.7 (2021-10-03)

### Changed

- Updated dependencies

## v4.2.6 (2021-09-30)

### Changed

- Recommended node versions bumped to v14.18.0 or v16.10.0

## v4.2.5 (2021-09-09)

### Changed

- Updated `ecovacs-deebot` library to v0.6.8

## v4.2.4 (2021-09-09)

### Changed

- Updated `ecovacs-deebot` library to v0.6.7

## v4.2.3 (2021-09-09)

### Changed

- `configureAccessory` function simplified to reduce chance of accessory cache retrieval failing

## v4.2.2 (2021-09-05)

### Changed

- Updated `ecovacs-deebot` library to v0.6.6

## v4.2.1 (2021-09-02)

### Changed

- Updated `ecovacs-deebot` library to v0.6.5
- Recommended node version bumped to v14.17.6

## v4.2.0 (2021-08-30)

### Changed

- Ignore `Robot is operational` error in log
- Updated `ecovacs-deebot` library to v0.6.3
- Remove `node-machine-id` in favour of generating a client id based on Ecovacs username

## v4.1.0 (2021-08-30)

_Unpublished_

## v4.0.2 (2021-08-12)

### Changed

- **Platform Versions**
  - Recommended node version bumped to v14.17.5

### Fixed

- Attempt to fix a situation when `node-machine-id` fails to obtain the machine uuid

## v4.0.1 (2021-08-06)

### Changed

- Updated `ecovacs-deebot` library to v0.6.1

## v4.0.0 (2021-07-29)

### Added

- **Configuration**
  - Plugin will now check for duplicate device ID entries in the config and ignore them

### Changed

- ⚠️ **Platform Versions**
  - Recommended node version bumped to v14.17.4
  - Recommended homebridge version bumped to v1.3.4

## v3.4.0 (2021-07-22)

### Added

- Support for cleaning 'Spot Areas' customised in the Ecovacs app

## v3.3.1 (2021-07-18)

### Fixed

- Don't refresh accessory if it hasn't initialised properly

## v3.3.0 (2021-07-18)

### Changed

- **Homebridge UI**
  - `label` field now appears first in the device configuration sections
  - A device can now be ignored/removed from Homebridge by the `ignoreDevice` setting in the device configuration sections
- Plugin will now use HomeKit `Battery` service type instead of `BatteryService`

### Fixed

- Attempt to fix an accessory duplication issue ([#37](https://github.com/homebridge-plugins/homebridge-ecovacs/issues/37))

### Removed

- `ignoredDevices` configuration option (see alternate way of ignore a device above)

## v3.2.2 (2021-07-08)

### Changes

- Revert node version bump to v14.17.3 (back to v14.17.2)

## v3.2.1 (2021-07-07)

### Changed

- Startup logging 'housekeeping'

## v3.2.0 (2021-07-07)

### Added

- **Accessory Logging**
  - `overrideLogging` setting per device type, which can be set to (and will override the global device logging and debug logging settings):
    - `"default"` to follow the global device update and debug logging setting for this accessory (default if setting not set)
    - `"standard"` to enable device update logging but disable debug logging for this accessory
    - `"debug"` to enable device update and debug logging for this accessory
    - `"disable"` to disable device update and debug logging for this accessory
  - Device online and offline notifications will now be shown in the logs
- **Clean Speed**
  - Clean speed characteristic to choose between 'standard' and 'max' (this option is only available in the Eve app)
- **Plugin-UI**
  - Additional device info in the plugin-ui including online status, IP and MAC address if available

### Changed

- More interactive Homebridge UI - device configuration will expand once device ID entered
- Small changes to the startup logging
- Avoid repeated logging of the same device error message
- Update `ecovacs-deebot` library
- Use `standard-prettier` code formatting
- Recommended node version bump to v14.17.3

## v3.1.0 (2021-05-10)

### Added

- HomeKit 'No Response' messages when controlling a device fails for any reason
  - This 'No Response' status will be reverted after two seconds

### Changed

- Ensure user is using at least Homebridge v1.3.0

### Removed

- Removed `encodedPassword` config option
  - The plugin will now initially try the supplied password and if incorrect will attempt another login with a base64 decoded version

## v3.0.3 (2021-05-05)

### Fixed

- Fixes an issue where commands didn't send to the device properly

## v3.0.2 (2021-05-04)

### Changed

- Accessory 'identify' function will now add an entry to the log
- Backend refactoring, function and variable name changes

## v3.0.1 (2021-04-24)

### Requirements

- **Homebridge Users**
  - This plugin has a minimum requirement of Homebridge v1.3.3
- **HOOBS Users**
  - This plugin has a minimum requirement of HOOBS v3.3.4

### Added

- Configuration settings per Deebot device
- Support for Chinese server login
- Enter your Ecovacs password as a base64 encoded string and use the option `encodedPassword` to let the plugin know
- More viewable information in the Homebridge plugin-ui:
  - Device model, company and an image of your device in case you didn't know what it looked like

### Changed

- ⚠️ The plugin now uses a **per-device** configuration
  - Current device-specific configurations will cease to work until you update your settings
  - Refer to [the wiki](https://github.com/homebridge-plugins/homebridge-ecovacs/wiki/Configuration) for details regarding the new configuration
- Use the new `.onSet` methods available in Homebridge v1.3
- Modified config schema to show titles/descriptions for non Homebridge UI users
- Update wiki links in the Homebridge plugin-ui
- More welcome messages
- Recover accessories from the cache using the UUID
- Updated `ecovacs-deebot` depencendy to 0.6.0 ([changelog](https://github.com/mrbungle64/ecovacs-deebot.js/releases/tag/0.6.0))
- Updated `plugin-ui-utils` dependency
- Updated recommended Node to v14.16.1
- Updated README to reflect minimum supported Homebridge/HOOBS and Node versions

### Fixed

- Fixes an issue where the device name would not show in the logs if a device fails to initialise

## v2.8.5 (2021-02-11)

### Changed

- Link 'Uninstall' wiki page in the plugin-ui
- Updated minimum Homebridge to v1.1.7
- Updated minimum Node to v14.15.5

## v2.8.4 (2021-02-09)

### Changed

- Updated client dependency `ecovacs-deebot` to v0.5.6

## v2.8.3 (2021-02-08)

### Fixed

- Hide the `Config entry [plugin_map] is unused and can be removed` notice for HOOBS users

## v2.8.2 (2021-02-08)

### Fixed

- Fixes a bug when adding a device to Homebridge

## v2.8.1 (2021-02-08)

### Changed

- Error stack will be hidden when the disabled plugin message appears in the log

## v2.8.0 (2021-02-06)

### Added

- New setting `hideMotionSensor` if you want to completely hide the motion sensor
- Configuration checks to highlight any unnecessary settings you have
- Link to 'Configuration' wiki page in the plugin-ui

### Changed

- ⚠️ `ignoredDevices` configuration option is now an array not a string
- Motion sensor settings will hide from the Homebridge UI if the sensor is hidden
- Devices are now configured only after the plugin has initialised
- Error messages refactored to show the most useful information
- [Backend] Major code refactoring
- [Backend] Code comments

## v2.7.2 (2021-01-30)

### Changed

- Updated client dependency `ecovacs-deebot` to v0.5.5 which:
  - Added OZMO T5 and some more T8 models

## v2.7.1 (2021-01-29)

### Changed

- More consistent and clearer error logging
- Minor code refactors
- Updated plugin-ui-utils dep and use new method to get cached accessories

### Fixed

- Corrected the attempt to disconnect from devices on Homebridge shutdown

## v2.7.0 (2021-01-26)

### New

- New configuration option `showMotionLowBatt` which:
  - when `true` the motion sensor will activate when the Deebot's battery reaches the low battery threshold
  - the motion sensor will not activate again until the battery charged above the threshold and then fallen again

### Changed

- Default low battery status reduced from 20% to 15% to match Deebot's low battery alerts

## v2.6.3 (2021-01-23)

### Changed

- Backend - better handling of errors

## v2.6.2 (2021-01-20)

### Changed

- Updated dependencies

## v2.6.1 (2021-01-14)

### Changed

- Replaced `countryCode` selectbox with inputbox for responsiveness
- Support for all valid country codes
- Added CHANGELOG.md

## v2.6.0 (2021-01-12)

### New

- New configuration option `disableDeviceLogging` to stop device state changes being logged

### Changed

- Improved validation checks and formatting for user inputs
- Changes to startup log messages
- Backend code changes

### Removed

- Removal of maximum value for `number` types on plugin settings screen
