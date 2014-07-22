var fs = require('fs');
var path = require('path');
var util = require('util');
var assert = require('assert');

var through = require('through');
var async = require('async');

module.exports = browserifyCache;
browserifyCache.getCacheObjects = getCacheObjects;
browserifyCache.getModuleCache = getModuleCache;
browserifyCache.getPackageCache = getPackageCache;
browserifyCache.invalidateCache = invalidateCache;
browserifyCache.invalidateModifiedFiles = invalidateModifiedFiles;
browserifyCache.updateMtime = updateMtime;

function browserifyCache(b, opts) {
  guard(b, 'browserify instance');
  opts = opts || {};

  if (getCacheObjects(b)) return b; // already attached

  var cacheFile = opts.cacheFile || opts.cachefile;

  loadCacheObjects(b, cacheFile);

  attachCacheObjectHandlers(b);
  
  var bundle = b.bundle.bind(b);
  
  b.bundle = function (opts_, cb) {
    if (b._pending) return bundle(opts_, cb);
    
    if (typeof opts_ === 'function') {
      cb = opts_;
      opts_ = {};
    }
    if (!opts_) opts_ = {};

    opts_.cache = getModuleCache(b);
    opts_.packageCache = getPackageCache(b);

    opts_.deps = function(depsOpts) {
      var depsStream = through();
      
      var co = getCacheObjects(b);

      invalidateCache(co.mtimes, co.modules, function(err, invalidated) {
        depsOpts.cache = co.modules;
        b.emit('update', invalidated);
        b.deps(depsOpts).pipe(depsStream);
      });

      return depsStream;
    }

    var outStream = bundle(opts_, cb);

    // store on completion
    outStream.on('end', function () {
      storeCacheObjects(b, cacheFile);
    })
    
    return outStream;
  };
  
  return b;
}

// caching

function getCacheObjects(b) {
  guard(b, 'browserify instance');
  return b.__cacheObjects;
}

function setCacheObjects(b, cacheObjects) {
  guard(b, 'browserify instance'), guard(cacheObjects, 'cacheObjects');
  b.__cacheObjects = cacheObjects;
}

function getModuleCache(b) {
  guard(b, 'browserify instance');
  var co = getCacheObjects(b);
  if (!Object.keys(co.modules).length) {
    return co.modules;
  }
}

function getPackageCache(b) {
  guard(b, 'browserify instance');
  var co = getCacheObjects(b);
  // rebuild packageCache from packages
  return Object.keys(co.filesPackagePaths).reduce(function(packageCache, file) {
    packageCache[file] = co.packages[co.filesPackagePaths[file]];
    return packageCache;
  }, {});
}

function attachCacheObjectHandlers(b) {
  guard(b, 'browserify instance');
  b.on('dep', function (dep) {
    var co = getCacheObjects(b);
    co.modules[dep.id] = dep;
    if (!co.mtimes[dep.id]) updateMtime(co.mtimes, dep.id);
  });

  b.on('package', function (file, pkg) {
    var co = getCacheObjects(b);

    var pkgpath = pkg.__dirname;

    if (pkgpath) {
      co.packages[pkgpath] || (co.packages[pkgpath] = pkg);
      co.filesPackagePaths[file] || (co.filesPackagePaths[file] = pkgpath);
      b.emit('cacheObjectsPackage', pkgpath, pkg)
    }
  });
}

function storeCacheObjects(b, cacheFile) {
  guard(b, 'browserify instance');
  if (cacheFile) {
    var co = getCacheObjects(b);
    fs.writeFile(cacheFile, JSON.stringify(co), {encoding: 'utf8'}, function(err) {
      if (err) b.emit('_cacheFileWriteError', err);
      else b.emit('_cacheFileWritten', cacheFile);
    });
  }
}

function loadCacheObjects(b, cacheFile) {
  guard(b, 'browserify instance');
  var co;  
  if (cacheFile && !getCacheObjects(b)) {
    try {
      co = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
    } catch (err) {
      // no existing cache file
      b.emit('_cacheFileReadError', err);
    }
  }
  // create initial cache structure
  // even when not loading anything
  co = co || {};
  co.modules = co.modules || {};
  co.packages = co.packages || {};
  co.mtimes = co.mtimes || {};
  co.filesPackagePaths = co.filesPackagePaths || {};
  setCacheObjects(b, co);
}

function updateMtime(mtimes, file) {
  fs.stat(file, function (err, stat) {
    if (!err) mtimes[file] = stat.mtime.getTime();
  });
}

function invalidateCache(mtimes, cache, done) {
  invalidateModifiedFiles(mtimes, Object.keys(cache), function(file) {
    delete cache[file];
  }, done)
}

function invalidateModifiedFiles(mtimes, files, invalidate, done) {
  async.reduce(files, [], function(invalidated, file, fileDone) {
    fs.stat(file, function (err, stat) {
      if (err) return fileDone();
      var mtimeNew = stat.mtime.getTime();
      if(!(mtimes[file] && mtimeNew && mtimeNew <= mtimes[file])) {
        invalidate(file);
        invalidated.push(file);
      }
      mtimes[file] = mtimeNew;
      fileDone(null, invalidated);
    });
  }, function(err, invalidated) {
    done(null, invalidated);
  });
}

// util

function guard(value, name) {
  assert(value, 'missing '+name);
}
