'use strict';

var _ = require('lodash');
var Include = require('./include');

function Adapter(options) {
  this.options = options;

  if (!this.options.baseUrl) {
    this.options.baseUrl = '';
  }

  if (!this.options.models || Object.keys(this.options.models).length <= 0) {
    throw new Error('Options must contain a models object with at least one model.');
  }

  this.filters = {};
}

function urlMerge() {
  var url = '';
  for (var i = 0, len = arguments.length; i < len; i++) {
    url += arguments[i];
    if (i < len -1) {
      url += '/';
    }
  }
  return url;
}

Adapter.prototype.getRelationshipById = function(name, id, relationshipName, cb) {
  try {
    var rootFactory = this.options.models[name];
    if (!rootFactory) return cb(null, null);

    var relationship = rootFactory.relationships[relationshipName];
    if (!relationship) return cb(null, null);

    var relatedData = rootFactory.model.forge({id: id})
    .related(relationshipName).relatedData;

    var withRelated = [];
    //include relationship in not one to many
    if (relatedData.type !== 'belongsTo') {
      withRelated = [relationshipName];
    }

    rootFactory.model.where({id : id}).fetch({withRelated: withRelated})
    .bind(this).then(function(data) {
      if (!data) return cb(null, null);

      var allIncludes = {
        withRelated: withRelated,
        includes: withRelated,
      };
      allIncludes.models = {};
      allIncludes.models[name] = {};
      allIncludes.models[name][relationshipName] = true;

      cb(null, getRelationshipFromModel(name, data, relationshipName,
        relationship.type, relatedData, this.options, allIncludes));
    });
  } catch(ex) {
    cb(ex, null);
  }
};

function getRelationshipFromModel(name, model, relationshipName, relationshipType,
  relatedData, options, includes) {
  if (!model) return null;

  if (relatedData.type === 'belongsTo') {
    var foreignKey = relatedData.foreignKey;
    var output = {
      links: {
        self: urlMerge(options.baseUrl, name, model.id, 'relationships',
          relationshipName),
        related: urlMerge(options.baseUrl, name, model.id, relationshipName)
      }
    };

    if (model.get(foreignKey)) {
      output.data = {
        type: relationshipType,
        id: model.get(foreignKey).toString()
      };
    } else {
      output.data = null;
    }

    return output;
  }

  if (relatedData.type === 'hasMany' || relatedData.type === 'belongsToMany') {
    var returnData = {
      links: {
        self: urlMerge(options.baseUrl, name, model.id, 'relationships',
          relationshipName),
        related: urlMerge(options.baseUrl, name, model.id, relationshipName)
      }
    };

    if (includes.models[name][relationshipName]) {
      returnData.data = model.related(relationshipName).toArray().map(function(item) {
        return {
          type: relationshipType,
          id: item.id.toString()
        };
      });
    }
    return returnData;
  }
}

Adapter.prototype.get = function(name, fields, includes, filters, cb) {
  try {
    var factory = this.options.models[name];
    var fetchModel = factory.model;
    var allIncludes = new Include(name, includes || [], this.options);

    return fetchModel.fetchAll({withRelated: allIncludes.withRelated})
    .bind(this).then(function(data) {
      try {
        if (!data) return cb(null, []);
        var sendJson = this.toJsonApi(name, data, fields, allIncludes);
        cb(null, sendJson);
      } catch(ex) {
        cb(ex);
      }
    })
    .catch(function(err) {
      cb(err);
    });
  } catch(ex) {
    cb(ex);
  }
};

Adapter.prototype.getById = function(name, id, fields, includes, filters, cb) {
  try {
    var factory = this.options.models[name];
    var fetchModel = factory.model.where({id : id});
    var allIncludes = new Include(name, includes || [], this.options);

    return fetchModel.fetch({withRelated: allIncludes.withRelated})
    .bind(this).then(function(data) {
      try {
        if (!data) return cb(null, null);
        var sendJson = this.toJsonApi(name, data, fields, allIncludes);
        cb(null, sendJson);
      } catch(ex) {
        cb(ex);
      }
    })
    .catch(function(err) {
      cb(err);
    });
  } catch(ex) {
    cb(ex);
  }
};

Adapter.prototype.toJsonApi = function(name, model, fields, includes) {
  var self = this;
  var sendData = {};
  if (model.toArray) {//collection
    sendData.data = model.toArray().map(function(eachModel) {
      return modelToJsonApi(name, eachModel, fields, includes, self.options);
    });
  } else {
    sendData.data = modelToJsonApi(name, model, fields, includes, self.options);
  }

  if (includes.includes.length > 0) {
    sendData.included = getAllIncludeModels(name, model, includes, self.options)
    .map(function(value) {
      return modelToJsonApi(value.name, value.model, fields,
        includes, self.options);
    });
  }

  return sendData;
};

function getAllIncludeModels(name, model, includes, options) {
  var allIncludeAsTree = includes.includes.map(function(include) {
    return getAllIncludesRecursively(name, model, include, options);
  });

  return _.uniq(_.flattenDeep(allIncludeAsTree), false, function(value) {
    return value.type + '-' + value.model.id; //join to make type-id unique
  }).filter(function(include) {
    return include.model.id;
  });
}

function getAllIncludesRecursively(name, model, include, options) {
  var relationshipName, relationshipType;

  if (include.indexOf('.') >= 0) {
    var includeTree = include.split('.');
    relationshipName = options.models[name].relationships[includeTree[0]].name;
    relationshipType = options.models[name].relationships[includeTree[0]].type;

    var values;
    if (model.toArray) { //bookshelf collection map over them
      values = model.toArray().map(function(model) {
        return getModelsFromRelationship(model, includeTree[0],
          relationshipName, relationshipType);
      });
    } else {
      values = getModelsFromRelationship(model, includeTree[0],
        relationshipName, relationshipType);
    }


    return [
      values,
      values.map(function(value) {
        return getAllIncludesRecursively(value.name, value.model,
          _.rest(includeTree).join('.'), options);
      })
    ];
  } else {
    relationshipName = options.models[name].relationships[include].name;
    relationshipType = options.models[name].relationships[include].type;

    if (model.toArray) { //bookshelf collection map over them
      return model.toArray().map(function(model) {
        return getModelsFromRelationship(model, include, relationshipName,
          relationshipType);
      });
    } else {
      return getModelsFromRelationship(model, include, relationshipName,
        relationshipType);
    }
  }
}

function getModelsFromRelationship(model, relationship, relationshipName,
relationshipType) {
  var relationshipData = model.related(relationship);
  if (relationshipData && relationshipData.toArray) { //bookshelf collection map over them
    return relationshipData.toArray().map(function(relationshipModel) {
      return {
        name: relationshipName,
        type: relationshipType,
        model: relationshipModel
      };
    });
  } else { // Single model
    return [
      {
        name: relationshipName,
        type: relationshipType,
        model: relationshipData
      }
    ];
  }
}

function modelToJsonApi(name, model, fields, includes, options) {
  if (!options.models[name]) {
    throw new Error('Adapter is missing model ' + name + '.');
  }

  var sendAttributes = model.attributes;
  delete sendAttributes.id;

  var sendRelationships = [];
  if (options.models[name].relationships) {
    Object.keys(options.models[name].relationships).forEach(function(key) {
      var relationship = options.models[name].relationships[key];
      var related = model.related(key);
      var relatedData = related.relatedData;

      if (relatedData) {
        var addingRelationship = getRelationshipFromModel(name, model, key,
          relationship.type, relatedData, options, includes);

        if (addingRelationship) {
          sendRelationships.push({
            name: key,
            value: addingRelationship
          });
        }

        if (relatedData.type === 'belongsTo') {
          delete sendAttributes[model.related(key).relatedData.foreignKey];
        }
      }
    });
  }

  var sendData = {
    type: options.models[name].type,
    id: model.id.toString(),
    attributes: sendAttributes
  };

  if (sendRelationships.length > 0) {
    sendData.relationships = {};
    sendRelationships.forEach(function(relationship) {
      sendData.relationships[relationship.name] = relationship.value;
    });
  }

  return sendData;
}

module.exports = Adapter;
