'use strict';

// Login strategies
angular.module('openshiftCommonServices')
.provider('RedirectLoginService', function() {
  var _oauth_client_id = "";
  var _oauth_authorize_uri = "";
  var _oauth_token_uri = "";
  var _oauth_redirect_uri = "";
  var _oauth_scope = "";

  this.OAuthClientID = function(id) {
    if (id) {
      _oauth_client_id = id;
    }
    return _oauth_client_id;
  };
  this.OAuthAuthorizeURI = function(uri) {
    if (uri) {
      _oauth_authorize_uri = uri;
    }
    return _oauth_authorize_uri;
  };
  this.OAuthTokenURI = function(uri) {
    if (uri) {
      _oauth_token_uri = uri;
    }
    return _oauth_token_uri;
  };
  this.OAuthRedirectURI = function(uri) {
    if (uri) {
      _oauth_redirect_uri = uri;
    }
    return _oauth_redirect_uri;
  };
  this.OAuthScope = function(scope) {
    if (scope) {
      _oauth_scope = scope;
    }
    return _oauth_scope;
  }

  this.$get = function($injector, $location, $q, Logger, base64) {
    var authLogger = Logger.get("auth");

    var getRandomInts = function(length) {
      var randomValues;

      if (window.crypto && window.Uint32Array) {
        try {
          var r = new Uint32Array(length);
          window.crypto.getRandomValues(r);
          randomValues = [];
          for (var j=0; j < length; j++) {
            randomValues.push(r[j]);
          }
        } catch(e) {
          authLogger.debug("RedirectLoginService.getRandomInts: ", e);
          randomValues = null;
        }
      }

      if (!randomValues) {
        randomValues = [];
        for (var i=0; i < length; i++) {
          randomValues.push(Math.floor(Math.random() * 4294967296));
        }
      }

      return randomValues;
    };

    var nonceKey = "RedirectLoginService.nonce";
    var makeState = function(then) {
      var nonce = String(new Date().getTime()) + "-" + getRandomInts(8).join("");
      try {
        if (window.localStorage[nonceKey] && window.localStorage[nonceKey].length > 10) {
          // Reuse an existing nonce if we have one, so that when multiple tabs get kicked to a login screen,
          // any of them can succeed, not just the last login flow that was started. The nonce gets cleared when the login flow completes.
          nonce = window.localStorage[nonceKey];
        } else {
          // Otherwise store the new nonce for comparison in parseState()
          window.localStorage[nonceKey] = nonce;
        }
      } catch(e) {
        authLogger.log("RedirectLoginService.makeState, localStorage error: ", e);
      }
      return base64.urlencode(JSON.stringify({then: then, nonce:nonce}));
    };
    var parseState = function(state) {
      var retval = {
        then: null,
        verified: false
      };

      var nonce = "";
      try {
        nonce = window.localStorage[nonceKey];
        window.localStorage.removeItem(nonceKey);
      } catch(e) {
        authLogger.log("RedirectLoginService.parseState, localStorage error: ", e);
      }

      try {
        var data = state ? JSON.parse(base64.urldecode(state)) : {};
        if (data && data.nonce && nonce && data.nonce === nonce) {
          retval.verified = true;
          retval.then = data.then;
        }
      } catch(e) {
        authLogger.error("RedirectLoginService.parseState, state error: ", e);
      }
      authLogger.error("RedirectLoginService.parseState", retval);
      return retval;
    };

    return {
      // Returns a promise that resolves with {user:{...}, token:'...', ttl:X}, or rejects with {error:'...'[,error_description:'...',error_uri:'...']}
      login: function() {
        if (_oauth_client_id === "") {
          return $q.reject({error:'invalid_request', error_description:'RedirectLoginServiceProvider.OAuthClientID() not set'});
        }
        if (_oauth_authorize_uri === "") {
          return $q.reject({error:'invalid_request', error_description:'RedirectLoginServiceProvider.OAuthAuthorizeURI() not set'});
        }
        if (_oauth_redirect_uri === "") {
          return $q.reject({error:'invalid_request', error_description:'RedirectLoginServiceProvider.OAuthRedirectURI not set'});
        }

        // Never send a local fragment to remote servers
        var returnUri = new URI($location.url()).fragment("");
        var authorizeParams = {
          client_id: _oauth_client_id,
          response_type: 'token',
          state: makeState(returnUri.toString()),
          redirect_uri: _oauth_redirect_uri
        };

        if (_oauth_scope) {
          authorizeParams.scope = _oauth_scope;
        }

        if (_oauth_token_uri) {
          authorizeParams.response_type = "code";
          // TODO: add PKCE
        }

        var deferred = $q.defer();
        var uri = new URI(_oauth_authorize_uri);
        uri.query(authorizeParams);
        authLogger.log("RedirectLoginService.login(), redirecting", uri.toString());
        window.location.href = uri.toString();
        // Return a promise we never intend to keep, because we're redirecting to another page
        return deferred.promise;
      },

      // Parses oauth callback parameters from window.location
      // Returns a promise that resolves with {token:'...',then:'...',verified:true|false}, or rejects with {error:'...'[,error_description:'...',error_uri:'...']}
      // If no token and no error is present, resolves with {}
      // Example error codes: https://tools.ietf.org/html/rfc6749#section-5.2
      finish: function() {
        // Obtain the $http service.
        // Can't declare the dependency directly because it causes a cycle between $http->AuthInjector->AuthService->RedirectLoginService
        var http = $injector.get("$http");

        // handleParams handles error or access_token responses
        var handleParams = function(params, stateData) {
          // Handle an error response from the OAuth server
          if (params.error) {
            authLogger.log("RedirectLoginService.finish(), error", params.error, params.error_description, params.error_uri);
            return $q.reject({
              error: params.error,
              error_description: params.error_description,
              error_uri: params.error_uri
            });
          }

          // Handle an access_token fragment response
          if (params.access_token) {
            return $q.when({
              token: params.access_token,
              ttl: params.expires_in,
              then: stateData.then,
              verified: stateData.verified
            });
          }

          // No token and no error is invalid
          return $q.reject({
            error: "invalid_request",
            error_description: "No API token returned"
          });
        };

        // Get url
        var u = new URI($location.url());

        // Read params
        var queryParams = u.query(true);
        var fragmentParams = new URI("?" + u.fragment()).query(true);
        authLogger.log("RedirectLoginService.finish()", queryParams, fragmentParams);

        // immediate error
        if (queryParams.error) {
          return handleParams(queryParams, parseState(queryParams.state));
        }
        // implicit error
        if (fragmentParams.error) {
          return handleParams(fragmentParams, parseState(fragmentParams.state));
        }
        // implicit success
        if (fragmentParams.access_token) {
          return handleParams(fragmentParams, parseState(fragmentParams.state));
        }
        // code flow
        if (_oauth_token_uri && queryParams.code) {
          // verify before attempting to exchange code for token
          // hard-fail state verification errors for code exchange
          var stateData = parseState(queryParams.state);
          if (!stateData.verified) {
            return $q.reject({
              error: "invalid_request",
              error_description: "Client state could not be verified"
            });
          }

          var tokenPostData = [
            "grant_type=authorization_code",
            "code="         + encodeURIComponent(queryParams.code),
            "redirect_uri=" + encodeURIComponent(_oauth_redirect_uri),
            "client_id="    + encodeURIComponent(_oauth_client_id)
          ].join("&");

          if (_oauth_scope) {
            tokenPostData += "&scope=" + encodeURIComponent(_oauth_scope);
          }

          return http({
            method: "POST",
            url: _oauth_token_uri,
            headers: {
              "Authorization": "Basic " + window.btoa(_oauth_client_id+":"),
              "Content-Type": "application/x-www-form-urlencoded"
            },
            data: tokenPostData
          }).then(function(response){
            return handleParams(response.data, stateData);
          }, function(response) {
            authLogger.log("RedirectLoginService.finish(), error getting access token", response);
            return handleParams(response.data, stateData);
          });
        }

        // No token and no error is invalid
        return $q.reject({
          error: "invalid_request",
          error_description: "No API token returned"
        });
      }
    };
  };
});
