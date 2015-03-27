var fs = require('fs');
var path = require('path');
var util = require('util');
var assert = require('assert');
var splicer = require('labeled-stream-splicer');
var through = require('through2');

var async = require('async');
var assign = require('xtend/mutable');

CONCURRENCY_LIMIT = 40;

module.exports = browserifyCache;
browserifyCache.getCacheObjects = getCacheObjects;
browserifyCache.getModuleCache = getModuleCache;
browserifyCache.getPackageCache = getPackageCache;
browserifyCache.invalidateCache = invalidateCache;
browserifyCache.invalidateModifiedFiles = invalidateModifiedFiles;
browserifyCache.updateMtime = updateMtime;
browserifyCache.args = { cache: {}, packageCache: {}, fullPaths: true };

function browserifyCache(b, opts) {
  assertExists(b);
  opts = opts || {};

  if (getCacheObjects(b)) return b; // already attached

  var cacheFile = opts.cacheFile || opts.cachefile || b._options && b._options.cacheFile || null;

  var cache;
  cache = loadCacheObjects(b, cacheFile);
  // even when not loading anything, create initial cache structure
  setCacheObjects(b, CacheObjects(cache));

  attachCacheObjectHooksToPipeline(b);  
  attachCacheObjectDiscoveryHandlers(b);
  attachCacheObjectPersistHandler(b, cacheFile);

  return b;
}

// browserify 5.x compatible
function attachCacheObjectHooksToPipeline(b) {
  var cache = getCacheObjects(b);

  assert(b._options.fullPaths, "required browserify 'fullPaths' opt not set")
  assert(b._options.cache, "required browserify 'cache' opt not set")
  // b._options.cache is a shared object into which loaded cache data is merged.
  // it will be reused for each build, and mutated when the cache is invalidated
  cache.modules = assign(b._options.cache, cache.modules);

  var bundle = b.bundle.bind(b);
  b.bundle = function (cb) {
    var outputStream = through.obj();

    invalidateCacheBeforeBundling(b, function(err, invalidated) {
      if (err) return outputStream.emit('error', err);

      var bundleStream = bundle(cb);
      proxyEvent(bundleStream, outputStream, 'file');
      proxyEvent(bundleStream, outputStream, 'package');
      proxyEvent(bundleStream, outputStream, 'transform');
      proxyEvent(bundleStream, outputStream, 'error');
      bundleStream.pipe(outputStream);
    });
    return outputStream;
  };
}

function invalidateCacheBeforeBundling(b, done) {
  assertExists(b);
  var cache = getCacheObjects(b);

  invalidateFilesPackagePaths(cache.filesPackagePaths, function() {
    invalidatePackageCache(cache.mtimes, cache.packages, function() {
      invalidateCache(cache.mtimes, cache.modules, function(err, invalidated, deleted) {
        invalidateDependentFiles(cache, [].concat(invalidated, deleted), function(err) {
          b.emit('changedDeps', invalidated, deleted);
          done(err, invalidated);
        });
      });
    });
  });
}

function attachCacheObjectDiscoveryHandlers(b) {
  assertExists(b);

  b.on('dep', function (dep) {
    updateCacheOnDep(b, dep);
  });

  b.on('transform', function (transformStream, moduleFile) {
    transformStream.on('file', function (dependentFile) {
      updateCacheOnTransformFile(b, moduleFile, dependentFile);
    });
  });
}

function attachCacheObjectPersistHandler(b, cacheFile) {
  assertExists(b);
  b.on('bundle', function(bundleStream) {
    // store on completion
    bundleStream.on('end', function () {
      storeCacheObjects(b, cacheFile);
    });
  });
}

function updateCacheOnTransformFile(b, moduleFile, dependentFile) {
  var cache = getCacheObjects(b);
  if (cache.dependentFiles[dependentFile] == null) {
    cache.dependentFiles[dependentFile] = {};
  }
  cache.dependentFiles[dependentFile][moduleFile] = true;
  if (!cache.mtimes[dependentFile]) updateMtime(cache.mtimes, dependentFile);
}

function updateCacheOnDep(b, dep) {
  var cache = getCacheObjects(b);
  var file = dep.file || dep.id;
  if (typeof file === 'string') {
    if (dep.source != null) {
      cache.modules[file] = dep;
      if (!cache.mtimes[file]) updateMtime(cache.mtimes, file);
    } else {
      console.warn('missing source for dep', file)
    }
  } else {
    console.warn('got dep missing file or string id', file);
  }
}


function proxyEventsFromModuleDepsStream(moduleDepsStream, target) {
  ['transform', 'file', 'missing', 'package'].forEach(function(eventName) {
    proxyEvent(moduleDepsStream, target, eventName);
  });
}

// caching

function CacheObjects(cache_) {
  var cache;
  // cache storage structure
  cache = cache_ || {};
  cache.modules = cache.modules || {}; // module-deps opt 'cache'
  cache.packages = cache.packages || {};  // module-deps opt 'packageCache'
  cache.mtimes = cache.mtimes || {}; // maps cached file filepath to mtime when cached
  cache.filesPackagePaths = cache.filesPackagePaths || {}; // maps file paths to parent package paths
  cache.dependentFiles = cache.dependentFiles || {};
  return cache;
}

function getCacheObjects(b) {
  assertExists(b);
  return b.__cacheObjects;
}

function setCacheObjects(b, cacheObjects) {
  assertExists(b); assertExists(cacheObjects);
  b.__cacheObjects = cacheObjects;
}

function getModuleCache(b) {
  assertExists(b);
  var cache = getCacheObjects(b);
  return cache.modules;
}

function getPackageCache(b) {
  assertExists(b);
  var cache = getCacheObjects(b);
  // rebuild packageCache from packages
  return Object.keys(cache.filesPackagePaths).reduce(function(packageCache, file) {
    packageCache[file] = cache.packages[cache.filesPackagePaths[file]];
    return packageCache;
  }, {});
}

function storeCacheObjects(b, cacheFile) {
  assertExists(b);
  if (cacheFile) {
    var cache = getCacheObjects(b);
    fs.writeFile(cacheFile, JSON.stringify(cache), {encoding: 'utf8'}, function(err) {
      if (err) b.emit('_cacheFileWriteError', err);
      else b.emit('_cacheFileWritten', cacheFile);
    });
  }
}

function loadCacheObjects(b, cacheFile) {
  assertExists(b);
  var cache = {};
  if (cacheFile && !getCacheObjects(b)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
    } catch (err) {
      // no existing cache file
      b.emit('_cacheFileReadError', err);
    }
  }
  return cache;
}

function updateMtime(mtimes, file) {
  assertExists(mtimes); assertExists(file);
  fs.stat(file, function (err, stat) {
    if (!err) mtimes[file] = stat.mtime.getTime();
  });
}

function invalidateCache(mtimes, cache, done) {
  assertExists(mtimes);
  invalidateModifiedFiles(mtimes, Object.keys(cache), function(file) {
    delete cache[file];
  }, done)
}

function packagePathForPackageFile(packageFilepath) {
  packageFilepath.slice(0, packageFilepath.length - 13); // 13 == '/package.json'.length
}

function packageFileForPackagePath(packagePath) {
  return path.join(packagePath,'package.json');
}

function invalidateDependentFiles(cacheObjects, invalidatedModules, done) {
  var moduleCache = cacheObjects.cache;
  var mtimes = cacheObjects.mtimes;
  var dependentFiles = cacheObjects.dependentFiles;

  // clean up maybe-no-longer-dependent modules
  var maybeNoLongerDependentModules = {}
  invalidatedModules.forEach(function(module) {
    maybeNoLongerDependentModules[module] = true;
  });
  Object.keys(dependentFiles).forEach(function(dependentFile) {
    if (dependentFiles[dependentFile]) {
      Object.keys(dependentFiles[dependentFile]).forEach(function(module) {
        if (maybeNoLongerDependentModules[module]) {
          delete dependentFiles[dependentFile][module];
        }
      });
    }
  });

  invalidateModifiedFiles(mtimes, Object.keys(dependentFiles), function(dependentFile) {
    Object.keys(dependentFiles[dependentFile]).forEach(function(module) {
      delete cache[module];
    })
  }, function(err, invalidated, deleted) { done(err); });
}

function invalidatePackageCache(mtimes, cache, done) {
  assertExists(mtimes);
  invalidateModifiedFiles(mtimes, Object.keys(cache).map(packageFileForPackagePath), function(file) {
    delete cache[packagePathForPackageFile(file)];
  }, done)
}

function invalidateModifiedFiles(mtimes, files, invalidate, done) {
  var invalidated = [];
  var deleted = [];
  async.eachLimit(files, CONCURRENCY_LIMIT, function(file, fileDone) {
    fs.stat(file, function (err, stat) {
      if (err) {
        deleted.push(file);
        return fileDone();
      }
      var mtimeNew = stat.mtime.getTime();
      if(!(mtimes[file] && mtimeNew && mtimeNew <= mtimes[file])) {
        invalidate(file);
        invalidated.push(file);
      }
      mtimes[file] = mtimeNew;
      fileDone();
    });
  }, function(err) {
    done(null, invalidated, deleted);
  });
}

// this is a big complex blob of code to deal with the small edge case where
// the package associated with a file changes (due to the addition or deletion
// of a package.json file) and the previous file => package association has 
// been cached, and thus needs to be invalidated
function invalidateFilesPackagePaths(filesPackagePaths, done) {
  assertExists(filesPackagePaths);
  var packagePathsFiles = invertFilesPackagePaths(filesPackagePaths);
  var foundPackageDirs = {};

  // invalidate files contained by intermediate dir from filesPackagePaths
  // and also remove from filesToCheck mutatively
  function invalidateFilesForInterstitialDir(filesToCheck, interstitialDir) {
    for (var i = filesToCheck.length-1; i >= 0; i--) {
      var filepath = filesToCheck[i];
      if (filepath.indexOf(interstitialDir) === 0) {
        delete filesPackagePaths[filepath]
        filesToCheck.splice(i, 1);
      }
    }
  }

  var packagePathsToCheck = Object.keys(packagePathsFiles).filter(function(pkgdir) {
    // anything in a node_modules dir isn't likely to have it's parent package change
    return pkgdir.indexOf('node_modules') == -1;
  });

  async.each(packagePathsToCheck, function(pkgdir, pkgdirDone) {
    fs.exists(packageFileForPackagePath(pkgdir), function(exists) {
      if (!exists) {
        // invalidate file in filesPackagePaths but don't bother figuring out new package path
        Object.keys(packagePathsFiles[pkgdir]).forEach(function(filepath) { delete filesPackagePaths[filepath]; });
        return pkgdirDone();
      }

      // could still be a new package in an interstitial dir between current package path and file
      foundPackageDirs[pkgdir] = true;
      var filesToCheck = Object.keys(packagePathsFiles[pkgdir]);
      var interstitialDirs = getInterstitialDirs(pkgdir, filesToCheck);

      async.each(interstitialDirs, function(interstitialDir, interstitialDirDone) {
        // return fast unless any left to invalidate which are contained by this intermediate dir
        if (!(
          filesToCheck.length 
          && filesToCheck.some(function(filepath){ return filepath.indexOf(interstitialDir) === 0; })
        )) return interstitialDirDone();

        // invalidate and return fast if this dir is known to now be a package path
        if (foundPackageDirs[interstitialDir]) {
          invalidateFilesForInterstitialDir(filesToCheck, interstitialDir);
          return interstitialDirDone();
        }

        fs.exists(packageFileForPackagePath(interstitialDir), function(exists) {
          if (exists) {
            foundPackageDirs[interstitialDir] = true;
            invalidateFilesForInterstitialDir(filesToCheck, interstitialDir);
          }
          interstitialDirDone();
        });
      }, pkgdirDone);
    });
  }, function(err) { done(null); }); // don't really care about errors
}

// get all directories between a common base and a list of files
function getInterstitialDirs(base, files) {
  return Object.keys(files.reduce(function(interstitialDirs, filepath) {
    var interstitialDir = filepath;
    while (
      (interstitialDir = path.dirname(interstitialDir))
      && interstitialDir !== base
      && !interstitialDirs[interstitialDir]
    ) {
      interstitialDirs[interstitialDir] = true;
    }
    return interstitialDirs;
  }, {}));
}

function invertFilesPackagePaths(filesPackagePaths) {
  var index = -1,
      props = Object.keys(filesPackagePaths),
      length = props.length,
      result = {};

  while (++index < length) {
    var key = props[index];
    var filepath = filesPackagePaths[key];
    result[filepath] = result[filepath] || {};
    result[filepath][key] = true;
  }
  return result;
}

// util 

function isBrowserify5x(b) {
  assertExists(b);
  return !!b._createPipeline;
}

function assertExists(value, name) {
  assert(value != null, 'missing '+(name || 'argument'));
}

function proxyEvent(source, target, name) {
  source.on(name, function() {
    target.emit.apply(target, [name].concat([].slice.call(arguments)));
  });
}
