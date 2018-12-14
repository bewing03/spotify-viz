/**
 * This is an example of a basic node.js script that performs
 * the Authorization Code oAuth2 flow to authenticate against
 * the Spotify Accounts.
 *
 * For more information, read
 * https://developer.spotify.com/web-api/authorization-guide/#authorization_code_flow
 */

var express = require('express'); // Express web server framework
var request = require('request'); // "Request" library
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
var fs = require('fs');
var queue = require('d3-queue');


var client_id = ''; // Your client id
var client_secret = ''; // Your secret
fs.readFile('secret_keys.txt', 'utf8', function (err, contents) {
    contents = contents.split('\n');
    client_id = contents[0];
    client_secret = contents[1];
});


var redirect_uri = 'http://localhost:8888/callback'; // Your redirect uri

/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
var generateRandomString = function (length) {
    var text = '';
    var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for (var i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

// function sleep(millis) {
//     return new Promise(resolve => setTimeout(resolve, millis));
// }

var stateKey = 'spotify_auth_state';

var app = express();

app.use(express.static(__dirname + '/public'))
    .use(cors())
    .use(cookieParser());

app.get('/login', function (req, res) {

    var state = generateRandomString(16);
    res.cookie(stateKey, state);

    // your application requests authorization
    var scope = 'user-read-private user-read-email user-top-read user-read-recently-played';
    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: client_id,
            scope: scope,
            redirect_uri: redirect_uri,
            state: state
        }));
});

app.get('/callback', function (req, res) {

    console.log('accessed callback');

    // your application requests refresh and access tokens
    // after checking the state parameter

    var code = req.query.code || null;
    var state = req.query.state || null;
    var storedState = req.cookies ? req.cookies[stateKey] : null;

    if (state === null || state !== storedState) {
        res.redirect('/#' +
            querystring.stringify({
                error: 'state_mismatch'
            }));
    } else {
        res.clearCookie(stateKey);
        var authOptions = {
            url: 'https://accounts.spotify.com/api/token',
            form: {
                code: code,
                redirect_uri: redirect_uri,
                grant_type: 'authorization_code'
            },
            headers: {
                'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
            },
            json: true
        };

        request.post(authOptions, function (error, response, body) {
            if (!error && response.statusCode === 200) {

                var access_token = body.access_token,
                    refresh_token = body.refresh_token;

                res.redirect('/#' +
                    querystring.stringify({
                        access_token: access_token,
                        refresh_token: refresh_token
                    }));
            } else {
                res.redirect('/#' +
                    querystring.stringify({
                        error: 'invalid_token'
                    }));
            }
        });
    }
});

app.get('/data', function (req, res) {
    var access_token = req.query.access_token,
        refresh_token = req.query.refresh_token;

    //things we need to request
    /*
    Top artists [100] (long term?) {genres, id, name, popularity?}
    'https://api.spotify.com/v1/me/top/artists'
    qs: {limit: 50, offset: i * limit}
    */
    var topOptions = {
        url: 'https://api.spotify.com/v1/me/top/artists',
        headers: {'Authorization': 'Bearer ' + access_token},
        qs: {limit: 50, offset: 0},
        json: true
    };

    /*

    Recent tracks [For past week or 500, whichever is second. Limit at a month] {played_at, track: {artists, id, name?}}
    'https://api.spotify.com/v1/me/player/recently-played'
    qs: {limit: 50, before: curr_oldest}
    */
    var recentOptions = {
        url: 'https://api.spotify.com/v1/me/player/recently-played',
        headers: {'Authorization': 'Bearer ' + access_token},
        qs: {limit: 50},
        json: true
    };
    var helperOptions = {
        url: 'https://api.spotify.com/v1/',
        headers: {'Authorization': 'Bearer ' + access_token},
        qs: {},
        json: true
    };

    /*

    This will be a lot of calls:
    Related artists [for each artist] for each {genres, id, name, popularity?}
    'https://api.spotify.com/v1/artists/{id}/related-artists'

    audio-features [for each 100 tracks] {valence}
    'https://api.spotify.com/v1/audio-features'
    qs: {ids: [spotify_ids]}
     */
    var relatedOptions = {
        url: 'https://api.spotify.com/v1/artists/{id}/related-artists',
        header: {'Authorization': 'Bearer ' + access_token},
        json: true
    };


    var recents = [];  // fields: time:DateTime str, artist:str, track:str
    var artistsGraph = {"nodes": [], "links": []}; // node fields: id:str, name:str; link fields: source:str, target:str
    var tracks = {};           // fields: name:str, valence:str representing float
    var topArtists = {};      // fields: name:str, genres:[str]
    var recentArtists = {};   // fields: name:str, genres:[str]
    var relatedArtists = {};  // fields: name:str, genres:[str]

    let extraInfo = {};

    /*
    for each requested top_artist:
        artists_graph.nodes.push({id, name})
        top_artists[id] = {name, genres, popularity?}
    */
    function requestTopArtists(options) {
        request.get(options, function (error, response, body) {
            if (error) {
                console.log(error);
                requestTopArtists(options);
            } else if (response.statusCode === 429) {
                setTimeout(() => requestTopArtists(options), 1000 * parseInt(response.headers['retry-after']));
            } else if (response.statusCode === 200) {
                for (var artistObject of body.items) {
                    if (!artistsGraph.nodes.map(e => e.id).includes(artistObject.id)) {
                        artistsGraph.nodes.push({id: artistObject.id, name: artistObject.name});
                    }
                    topArtists[artistObject.id] = {name: artistObject.name, genres: artistObject.genres};
                }
                if (options.qs.offset === 0) {
                    options.qs.offset += 50;
                    requestTopArtists(options);
                } else { // move on
                    requestRecents(recentOptions, 0);
                }
            }
        });
    }


    /*

    artists_info = request.artist(track.artists)
    features = request.features(recent_tracks)
    for each requested recent_track:
        recents.push({time: played_at, artist: track.artists, track: track.name})
        for artist, info, feature in zip(track.artists, artists_info, features):
            recent_artists[artist] = {name: artist.name, genres: info.genres}
            artists_graph.nodes.push({artist.id, artist.name})
        for track in tracks:
            tracks[track.id] = {track.name, valence: feature.valence}
    */
    function requestHelper(ids, helperType, next) {
        helperOptions.url = "https://api.spotify.com/v1/";
        helperOptions.qs = {ids: ids.toString()};
        helperOptions.url += helperType;
        request.get(helperOptions, function (error, response, body) {
            if (error) {
                console.log(error);
                requestHelper(ids, helperType, next);
            } else if (response.statusCode === 429) {
                setTimeout(() => requestHelper(ids, helperType, next), 1000 * parseInt(response.headers['retry-after']))
            } else {
                extraInfo[helperType] = body[Object.keys(body)[0]];
                next(extraInfo);
            }
        });
    }

    function requestRecents(options, iterations) {
        request.get(options, function (error, response, body) {
            if (error) {
                console.log(error);
                requestRecents(options, iterations);
            } else if (response.statusCode === 429) {
                setTimeout(() => requestRecents(options), 1000 * parseInt(response.headers['retry-after']));
            } else if (response.statusCode === 200) {
                requestHelper(body.items.map(e => e.track.artists[0].id), 'artists', extraInfo =>
                    requestHelper(body.items.map(e => e.track.id), 'audio-features', extraInfo => {
                        for (var i = 0; i < body.items.length; i++) {
                            var currItem = body.items[i];
                            recents.push({
                                time: currItem.played_at,
                                artist: currItem.track.artists[0].id,
                                track: currItem.track.id
                            });
                            recentArtists[currItem.track.artists[0].id] = {name: currItem.track.artists[0].name, genres: extraInfo['artists'][i].genres};

                            if (!artistsGraph.nodes.map(e => e.id).includes(currItem.track.artists[0].id)) {
                                artistsGraph.nodes.push({
                                    id: currItem.track.artists[0].id,
                                    name: currItem.track.artists[0].name
                                });
                            }
                            tracks[currItem.track.id] = {name: currItem.track.name, valence: extraInfo['audio-features'][i].valence};
                        }

                        if (iterations < 10 && body.next.cursors !== undefined) {
                            options.qs = {limit: 50, before: body.next.cursors.before};
                            requestRecents(options, iterations + 1);
                        } else {  // move on
                            requestAllRelatedArtists();
                        }
                    })
                );
            } else {
                requestRecents(options);
            }
        });
    }

    /*

    for each artist in top_artists U recent_artists:
        relateds = request.related_artists(artists)
        for related in relateds:
            if related not in top_artists U recent_artists:
                related_artists[related.id] = {related.name, related.genres}
            artist_graph.links.push({source:artist, target:related})

     */
    function requestAllRelatedArtists() {
        function union(setA, setB) {
            var _union = new Set(setA);
            for (var elem of setB) {
                _union.add(elem);
            }
            return _union;
        }

        requestRelated(Array.from(union(Object.keys(recentArtists), Object.keys(topArtists))), 0);
    }

    function requestRelated(allArtistIds, iteration) {
        relatedOptions.url = 'https://api.spotify.com/v1/artists/' + allArtistIds[iteration] + '/related-artists';
        request.get(relatedOptions, function (error, response, body) {
            if (error) {
                console.log(error);
                requestRelated(allArtistIds, iteration, artistsGraph);
            } else if (response.statusCode === 429) {
                setTimeout(() => requestRelated(allArtistIds, iteration, artistsGraph), 1000 * parseInt(response.headers['retry-after']));
            } else if (response.statusCode === 200) {
                for (var item of body.artists) {
                    if (!(item.id in topArtists || item.id in recentArtists)) {
                        relatedArtists[item.id] = {name: item.name, genres: item.genres};
                        artistsGraph.nodes.push({id: item.id, name: item.name});
                    }
                    if (!(artistsGraph.links.includes({
                        source: item.id,
                        target: allArtistIds[iteration]
                    }))) {  // should never include the opposite
                        artistsGraph.links.push({source: allArtistIds[iteration], target: item.id});
                    }
                }

                if (iteration === allArtistIds.length - 1) {
                    res.send(
                        {
                            recents: recents,
                            artistsGraph: artistsGraph,
                            tracks: tracks,
                            topArtists: topArtists,
                            recentArtists: recentArtists,
                            relatedArtists: relatedArtists
                        });
                } else {
                    requestRelated(allArtistIds, iteration + 1, artistsGraph);
                }
            } else if (response.statusCode === 401) {
                var authOptions = {
                    url: 'https://accounts.spotify.com/api/token',
                    headers: {'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))},
                    form: {
                        grant_type: 'refresh_token',
                        refresh_token: refresh_token
                    },
                    json: true
                };

                request.post(authOptions, function (error, response, body) {
                    if (!error && response.statusCode === 200) {
                        relatedOptions.headers = {'Authorization': 'Bearer ' + body.access_token};
                        access_token = body.access_token;
                        requestRelated(allArtistIds, iteration, artistsGraph);
                    }
                });


            } else {
                console.log('we screwed up');
            }
        });
    }


    function test_this() {
        request.get(user_data_options, function (error, response, body) {
            console.log(response.statusCode);
            var test_num = 0;
            if (response.statusCode === 429) {
                console.log(response.headers['retry-after']);
                test_num = Number(response.headers['retry-after']);
                // sleep(response.headers['retry-after']); // need to work on sleep func
            }
            // if (user_data_options.qs.offset >= 500) {
            //     return;
            // }
            user_data_options.qs.offset += 50;
            setTimeout(test_this, 1000 * test_num);

            // console.log(response);

            // for (var item of body.items) {
            //
            //   if (type === 'tracks') {
            //       var artists = [];
            //       for (var i = 0; i < item.artists.length; i++) {
            //           artists.push(item.artists[i].name);
            //       }
            //       console.log(artists.join(', '));
            //   }
            //
            //   console.log(item.name);
            //   console.log(item.popularity);
            //   console.log();
            // }
        });
    }

    // test_this();
    requestTopArtists(topOptions);

    // we can also pass the token to the browser to make requests from there
    // res.redirect('/#' +
    //     querystring.stringify({
    //         access_token: access_token,
    //         refresh_token: refresh_token
    //     }));
});

app.get('/refresh_token', function (req, res) {

    // requesting access token from refresh token
    var refresh_token = req.query.refresh_token;
    var authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        headers: {'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))},
        form: {
            grant_type: 'refresh_token',
            refresh_token: refresh_token
        },
        json: true
    };

    request.post(authOptions, function (error, response, body) {
        if (!error && response.statusCode === 200) {
            var access_token = body.access_token;
            res.send({
                'access_token': access_token
            });
        }
    });
});

console.log('Listening on 8888');
app.listen(8888);
