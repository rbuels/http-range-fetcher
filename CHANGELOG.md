# [1.5.0](https://github.com/rbuels/http-range-fetcher/compare/v1.4.0...v1.5.0) (2022-04-06)



# [1.4.0](https://github.com/rbuels/http-range-fetcher/compare/v1.3.0...v1.4.0) (2022-04-01)



<a name="1.3.0"></a>

# [1.3.0](https://github.com/rbuels/http-range-fetcher/compare/v1.2.5...v1.3.0) (2022-02-15)

- Add ESM build of http-range-fetcher using typescript based build system (#29)

<a name="1.2.5"></a>

## [1.2.5](https://github.com/rbuels/http-range-fetcher/compare/v1.2.4...v1.2.5) (2021-06-03)

- Make standard-changelog a devDependency instead of a dependency

<a name="1.2.4"></a>

## [1.2.4](https://github.com/rbuels/http-range-fetcher/compare/v1.2.3...v1.2.4) (2020-02-28)

- Fix issue where stats cache can result in undefined due to LRU evacuation (#12, #13)

## [1.2.2](https://github.com/rbuels/http-range-fetcher/compare/v1.2.1...v1.2.2) (2019-05-09)

- Fix a chunk caching issue that was preventing aborting from working properly
- Catch more aborting type exceptions

## [1.2.1](https://github.com/rbuels/http-range-fetcher/compare/v1.2.0...v1.2.1) (2019-05-07)

- Fix usage of AbortController in the browser (pull #4)
- Update to babel 7 and @babel/env

## [1.2.0](https://github.com/rbuels/http-range-fetcher/compare/v1.1.2...v1.2.0) (2019-04-03)

- Fix promise leak and aborting rejection

## [1.1.2](https://github.com/rbuels/http-range-fetcher/compare/v1.1.1...v1.1.2) (2018-11-24)

- Fix cache deleting for quick-lru

## [1.1.1](https://github.com/rbuels/http-range-fetcher/compare/v1.1.0...v1.1.1) (2018-11-23)

- Change from lru-cache to quick-lru

## [1.1.0](https://github.com/rbuels/http-range-fetcher/compare/v1.0.0...v1.1.0) (2018-08-07)

- Expose maxExtraFetch and maxExtraSize params

## 1.0.0 (2018-08-07)

- Initial release
