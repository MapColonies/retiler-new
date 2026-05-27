# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [5.0.0](https://github.com/MapColonies/retiler-new/compare/v4.0.1...v5.0.0) (2026-05-27)


### ⚠ BREAKING CHANGES

* optionally filter out blank tiles and service modernize ([#41](https://github.com/MapColonies/retiler-new/issues/41))
* multi tile storage destinations including fs ([#30](https://github.com/MapColonies/retiler-new/issues/30))
* changed default format for arcgis map ([#15](https://github.com/MapColonies/retiler-new/issues/15))
* changed default format for arcgis map

### Features

* added application metrics ([#28](https://github.com/MapColonies/retiler-new/issues/28)) ([fb120eb](https://github.com/MapColonies/retiler-new/commit/fb120eb22ed574e1dc1989ce306168b96a5b0b2d))
* added core dump debug capabillity and upgraded sharp ([#24](https://github.com/MapColonies/retiler-new/issues/24)) ([8cef15d](https://github.com/MapColonies/retiler-new/commit/8cef15d50a8527fed70ba4ce7004569bf5c7755f))
* added detiler ([#35](https://github.com/MapColonies/retiler-new/issues/35)) ([892b755](https://github.com/MapColonies/retiler-new/commit/892b755827dbc9cb810c9d3287baa67c855e27a8))
* added option to run multiple jobs in parallal ([93061a8](https://github.com/MapColonies/retiler-new/commit/93061a88643eea04fde48b7aa31ed7e824957bb7))
* added option to run multiple jobs in parallel ([03308e1](https://github.com/MapColonies/retiler-new/commit/03308e14f383b40dc51250ef22a208047c68722e))
* added option to run multiple jobs in parallel ([#16](https://github.com/MapColonies/retiler-new/issues/16)) ([03308e1](https://github.com/MapColonies/retiler-new/commit/03308e14f383b40dc51250ef22a208047c68722e))
* axios injection and configurable config ([#4](https://github.com/MapColonies/retiler-new/issues/4)) ([dc2ee43](https://github.com/MapColonies/retiler-new/commit/dc2ee43d315ab40dee2f8d69fab257d96b877153))
* changed to run forever ([#26](https://github.com/MapColonies/retiler-new/issues/26)) ([f2b0c18](https://github.com/MapColonies/retiler-new/commit/f2b0c181fd85cdeeacdfdd38ca91a0e9528bd657))
* implementation ([#1](https://github.com/MapColonies/retiler-new/issues/1)) ([56d9f6d](https://github.com/MapColonies/retiler-new/commit/56d9f6dd2a39580e85ba9ee82561036018302ad7))
* improved storage layout and splitter filtering out of bounds ([#6](https://github.com/MapColonies/retiler-new/issues/6)) ([2e30a0b](https://github.com/MapColonies/retiler-new/commit/2e30a0b8d999e49bc629e2e477760d6bb97acce2))
* multi tile storage destinations including fs ([#30](https://github.com/MapColonies/retiler-new/issues/30)) ([b2e3126](https://github.com/MapColonies/retiler-new/commit/b2e3126d768fa3e1d9011eab2e0e352d5c5e1d60))
* optionally filter out blank tiles and service modernize ([#41](https://github.com/MapColonies/retiler-new/issues/41)) ([adaf4bf](https://github.com/MapColonies/retiler-new/commit/adaf4bf50f5eec52f733d568156099b9c38de64f))
* tile rendering pre-process cooldown validation ([#39](https://github.com/MapColonies/retiler-new/issues/39)) ([c3408b0](https://github.com/MapColonies/retiler-new/commit/c3408b05ddabc765ac9315d0f19e54368ff6fdd1))
* wms map provider ([#20](https://github.com/MapColonies/retiler-new/issues/20)) ([19e3e98](https://github.com/MapColonies/retiler-new/commit/19e3e98cc1cb23df8c84f70c2b46fbbbb6e2a5e9))


### Bug Fixes

* **configurations:** helm templates and values up to date ([#32](https://github.com/MapColonies/retiler-new/issues/32)) ([6c0d2ad](https://github.com/MapColonies/retiler-new/commit/6c0d2add173197f1ea077708bf6e715c424d0bc3))
* logger in index.ts ([#21](https://github.com/MapColonies/retiler-new/issues/21)) ([21b571f](https://github.com/MapColonies/retiler-new/commit/21b571f295ed9e592c335901e42a4a5c7791c3ea))
* pgboss connection options not nested under db ([#11](https://github.com/MapColonies/retiler-new/issues/11)) ([6ddc857](https://github.com/MapColonies/retiler-new/commit/6ddc85760254a50c13d1e160c7fde7284e0fdbe6))
* removed console log ([866f435](https://github.com/MapColonies/retiler-new/commit/866f435eca8ed717b36b49159a8a9bbf9a0af11e))
* removed redundant whitespace ([9e7c767](https://github.com/MapColonies/retiler-new/commit/9e7c7674be8d840bc295439fcce8a648a27a096a))
* tile save  ([#90](https://github.com/MapColonies/retiler-new/issues/90)) ([2cd609c](https://github.com/MapColonies/retiler-new/commit/2cd609c1f1b09a710caa93aef9cb1a946d377ad6))


### Reverts

* removed segfault-handler ([#25](https://github.com/MapColonies/retiler-new/issues/25)) ([c3a9c3e](https://github.com/MapColonies/retiler-new/commit/c3a9c3eddd5251103ae3d72445a7c70a56af637a))


### Code Refactoring

* changed default format for arcgis map ([68fdc1b](https://github.com/MapColonies/retiler-new/commit/68fdc1b0a7bbcf9e2b180b309437d021f5581a59))
* changed default format for arcgis map ([#15](https://github.com/MapColonies/retiler-new/issues/15)) ([2d837ea](https://github.com/MapColonies/retiler-new/commit/2d837eac1c738c083d84f154a416eaa5acc1020e))

## [4.0.1](https://github.com/MapColonies/retiler/compare/v4.0.0...v4.0.1) (2026-04-07)


### Bug Fixes

* tile save  ([#90](https://github.com/MapColonies/retiler/issues/90)) ([2cd609c](https://github.com/MapColonies/retiler/commit/2cd609c1f1b09a710caa93aef9cb1a946d377ad6))

## [4.0.0](https://github.com/MapColonies/retiler/compare/v3.2.0...v4.0.0) (2025-08-19)


### ⚠ BREAKING CHANGES

* optionally filter out blank tiles and service modernize ([#41](https://github.com/MapColonies/retiler/issues/41))

### Features

* optionally filter out blank tiles and service modernize ([#41](https://github.com/MapColonies/retiler/issues/41)) ([adaf4bf](https://github.com/MapColonies/retiler/commit/adaf4bf50f5eec52f733d568156099b9c38de64f))

## [3.2.0](https://github.com/MapColonies/retiler/compare/v3.1.1...v3.2.0) (2024-12-08)


### Features

* tile rendering pre-process cooldown validation ([#39](https://github.com/MapColonies/retiler/issues/39)) ([c3408b0](https://github.com/MapColonies/retiler/commit/c3408b05ddabc765ac9315d0f19e54368ff6fdd1))

### [3.1.1](https://github.com/MapColonies/retiler/compare/v3.1.0...v3.1.1) (2024-10-21)

## [3.1.0](https://github.com/MapColonies/retiler/compare/v3.0.0...v3.1.0) (2024-08-13)


### Features

* added detiler ([#35](https://github.com/MapColonies/retiler/issues/35)) ([892b755](https://github.com/MapColonies/retiler/commit/892b755827dbc9cb810c9d3287baa67c855e27a8))

## [3.0.0](https://github.com/MapColonies/retiler/compare/v2.1.0...v3.0.0) (2023-12-04)


### ⚠ BREAKING CHANGES

* multi tile storage destinations including fs (#30)

### Features

* multi tile storage destinations including fs ([#30](https://github.com/MapColonies/retiler/issues/30)) ([b2e3126](https://github.com/MapColonies/retiler/commit/b2e3126d768fa3e1d9011eab2e0e352d5c5e1d60))


### Bug Fixes

* **configurations:** helm templates and values up to date ([#32](https://github.com/MapColonies/retiler/issues/32)) ([6c0d2ad](https://github.com/MapColonies/retiler/commit/6c0d2add173197f1ea077708bf6e715c424d0bc3))

## [2.1.0](https://github.com/MapColonies/retiler/compare/v2.0.0...v2.1.0) (2023-06-22)


### Features

* added application metrics ([#28](https://github.com/MapColonies/retiler/issues/28)) ([fb120eb](https://github.com/MapColonies/retiler/commit/fb120eb22ed574e1dc1989ce306168b96a5b0b2d))

## [2.0.0](https://github.com/MapColonies/retiler/compare/v1.3.0...v2.0.0) (2023-06-14)


### Features

* changed to run forever ([#26](https://github.com/MapColonies/retiler/issues/26)) ([f2b0c18](https://github.com/MapColonies/retiler/commit/f2b0c181fd85cdeeacdfdd38ca91a0e9528bd657))

## [1.3.0](https://github.com/MapColonies/retiler/compare/v1.2.0...v1.3.0) (2023-03-26)


### Features

* added core dump debug capabillity and upgraded sharp ([#24](https://github.com/MapColonies/retiler/issues/24)) ([8cef15d](https://github.com/MapColonies/retiler/commit/8cef15d50a8527fed70ba4ce7004569bf5c7755f))

## [1.2.0](https://github.com/MapColonies/retiler/compare/v1.1.1...v1.2.0) (2022-08-29)


### Features

* wms map provider ([#20](https://github.com/MapColonies/retiler/issues/20)) ([19e3e98](https://github.com/MapColonies/retiler/commit/19e3e98cc1cb23df8c84f70c2b46fbbbb6e2a5e9))


### Bug Fixes

* logger in index.ts ([#21](https://github.com/MapColonies/retiler/issues/21)) ([21b571f](https://github.com/MapColonies/retiler/commit/21b571f295ed9e592c335901e42a4a5c7791c3ea))

### [1.1.1](https://github.com/MapColonies/retiler/compare/v1.1.0...v1.1.1) (2022-06-15)

## [1.1.0](https://github.com/MapColonies/retiler/compare/v1.0.0...v1.1.0) (2022-05-03)


### Features

* added option to run multiple jobs in parallal ([93061a8](https://github.com/MapColonies/retiler/commit/93061a88643eea04fde48b7aa31ed7e824957bb7))
* added option to run multiple jobs in parallel ([#16](https://github.com/MapColonies/retiler/issues/16)) ([03308e1](https://github.com/MapColonies/retiler/commit/03308e14f383b40dc51250ef22a208047c68722e))


### Bug Fixes

* removed console log ([866f435](https://github.com/MapColonies/retiler/commit/866f435eca8ed717b36b49159a8a9bbf9a0af11e))
* removed redundant whitespace ([9e7c767](https://github.com/MapColonies/retiler/commit/9e7c7674be8d840bc295439fcce8a648a27a096a))

## 1.0.0 (2022-04-27)


### ⚠ BREAKING CHANGES

* changed default format for arcgis map (#15)
* changed default format for arcgis map

### Features

* axios injection and configurable config ([#4](https://github.com/MapColonies/retiler/issues/4)) ([dc2ee43](https://github.com/MapColonies/retiler/commit/dc2ee43d315ab40dee2f8d69fab257d96b877153))
* implementation ([#1](https://github.com/MapColonies/retiler/issues/1)) ([56d9f6d](https://github.com/MapColonies/retiler/commit/56d9f6dd2a39580e85ba9ee82561036018302ad7))
* improved storage layout and splitter filtering out of bounds ([#6](https://github.com/MapColonies/retiler/issues/6)) ([2e30a0b](https://github.com/MapColonies/retiler/commit/2e30a0b8d999e49bc629e2e477760d6bb97acce2))


### Bug Fixes

* pgboss connection options not nested under db ([#11](https://github.com/MapColonies/retiler/issues/11)) ([6ddc857](https://github.com/MapColonies/retiler/commit/6ddc85760254a50c13d1e160c7fde7284e0fdbe6))


* changed default format for arcgis map ([68fdc1b](https://github.com/MapColonies/retiler/commit/68fdc1b0a7bbcf9e2b180b309437d021f5581a59))
* changed default format for arcgis map ([#15](https://github.com/MapColonies/retiler/issues/15)) ([2d837ea](https://github.com/MapColonies/retiler/commit/2d837eac1c738c083d84f154a416eaa5acc1020e))
