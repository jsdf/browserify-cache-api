var fs = require('fs');
var assert = require('assert');
var through = require('through2');
var assign = require('xtend/mutable');

var assertExists = require('./assertExists');
var proxyEvent = require('./proxyEvent');
var Cache = require('./Cache');
var invalidateFilesPackagePaths = require('./invalidateFilesPackagePaths');
var invalidatePackageCache = require('./invalidatePackageCache');
var invalidateCache = require('./invalidateCache');
var invalidateDependentFiles = require('./invalidateDependentFiles');

function BrowserifyCache(b, opts) {
  assertExists(b);
  opts = opts || {};

  if (BrowserifyCache.getCache(b)) return b; // already attached

  // certain opts must have been set when browserify instance was created
  assert(b._options.fullPaths != null, "required browserify 'fullPaths' opt not set");
  assert(b._options.cache != null, "required browserify 'cache' opt not set");

  // load cache from file specified by cacheFile opt
  var cacheFile = opts.cacheFile || opts.cachefile || b._options && b._options.cacheFile || null;
  var cacheData = loadCacheData(b, cacheFile);

  // b._options.cache is a shared object into which loaded module cache is merged.
  // it will be reused for each build, and mutated when the cache is invalidated.
  assign(b._options.cache, cacheData.modules);
  cacheData.modules = b._options.cache;

  var cache = Cache(cacheData);
  BrowserifyCache.setCache(b, cache);

  attachCacheHooksToPipeline(b);
  attachCacheDiscoveryHandlers(b);
  attachCachePersistHandler(b, cacheFile);

  return b;
}

BrowserifyCache.args = {cache: {}, packageCache: {}, fullPaths: true};

BrowserifyCache.getCache = function(b) {
  return b.__cacheObjects;
};

BrowserifyCache.setCache = function(b, cache) {
  b.__cacheObjects = cache;
};

BrowserifyCache.getModuleCache = function(b) {
  var cache = BrowserifyCache.getCache(b);
  return cache.modules;
};

BrowserifyCache.getPackageCache = function(b) {
  var cache = BrowserifyCache.getCache(b);
  // rebuild packageCache from packages
  return Object.keys(cache.filesPackagePaths).reduce(function(packageCache, file) {
    packageCache[file] = cache.packages[cache.filesPackagePaths[file]];
    return packageCache;
  }, {});
};

function addCacheBlocker(b) {
  if (b.__cacheBlockerCount == null) {
    b.__cacheBlockerCount = 0;
  }

  b.__cacheBlockerCount++;
}

function removeCacheBlocker(b) {
  assert(b.__cacheBlockerCount >= 1);

  b.__cacheBlockerCount--;

  if (b.__cacheBlockerCount === 0) {
    b.emit('_cacheReadyToWrite');
  }
}

function attachCacheHooksToPipeline(b) {
  var prevBundle = b.bundle;
  b.bundle = function(cb) {
    var outputStream = through.obj();

    invalidateCacheBeforeBundling(b, function(err) {
      if (err) return outputStream.emit('error', err);

      var bundleStream = prevBundle.call(b, cb);
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
  var cache = BrowserifyCache.getCache(b);

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

function attachCacheDiscoveryHandlers(b) {
  b.on('dep', function(dep) {
    addCacheBlocker(b);
    updateCacheOnDep(b, dep, function(err) {
      if (err) b.emit('error', err);
      removeCacheBlocker(b);
    });
  });

  b.on('transform', function(transformStream, moduleFile) {
    transformStream.on('file', function(dependentFile) {
      addCacheBlocker(b);
      updateCacheOnTransformFile(b, moduleFile, dependentFile, function(err) {
        if (err) b.emit('error', err);
        removeCacheBlocker(b);
      });
    });
  });
}

function updateCacheOnDep(b, dep, done) {
  var cache = BrowserifyCache.getCache(b);
  var file = dep.file || dep.id;
  if (typeof file === 'string') {
    if (dep.source != null) {
      cache.modules[file] = dep;
      if (!cache.mtimes[file])
        return updateMtime(cache.mtimes, file, done);
    } else {
      console.warn('missing source for dep', file);
    }
  } else {
    console.warn('got dep missing file or string id', file);
  }
  done();
}

function updateCacheOnTransformFile(b, moduleFile, dependentFile, done) {
  var cache = BrowserifyCache.getCache(b);
  if (cache.dependentFiles[dependentFile] == null) {
    cache.dependentFiles[dependentFile] = {};
  }
  cache.dependentFiles[dependentFile][moduleFile] = true;
  if (!cache.mtimes[dependentFile])
    return updateMtime(cache.mtimes, dependentFile, done);
  done();
}

function attachCachePersistHandler(b, cacheFile) {
  if (!cacheFile) return;

  b.on('bundle', function(bundleStream) {
    addCacheBlocker(b);
    bundleStream.on('end', function() {
      removeCacheBlocker(b);
    });
    // We need to wait until the cache is done being populated.
    // Use .once because the `b` browserify object can be re-used for multiple
    // bundles. We only want to save the cache once per bundle call.
    b.once('_cacheReadyToWrite', function() {
      storeCache(b, cacheFile);
    });
  });
}

function storeCache(b, cacheFile) {
  assertExists(cacheFile);

  var cache = BrowserifyCache.getCache(b);
  fs.writeFile(cacheFile, JSON.stringify(cache), {encoding: 'utf8'}, function(err) {
    if (err) b.emit('_cacheFileWriteError', err);
    else b.emit('_cacheFileWritten', cacheFile);
  });
}

function loadCacheData(b, cacheFile) {
  var cacheData = {};

  if (cacheFile) {
    try {
      cacheData = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
    } catch (err) {
      // no existing cache file
      b.emit('_cacheFileReadError', err);
    }
  }

  return cacheData;
}

function updateMtime(mtimes, file, done) {
  assertExists(mtimes);
  assertExists(file);

  fs.stat(file, function(err, stat) {
    if (!err) mtimes[file] = stat.mtime.getTime();
    done();
  });
}

module.exports = BrowserifyCache;
