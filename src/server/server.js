(function(){
    /*jslint bitwise: true, node: true */
    'use strict';

    var express = require('express');
    var app = express();
    var http = require('http').Server(app);
    var io = require('socket.io')(http);
    var SAT = require('sat');
    // Import game settings
    var c = require('../../config.json');
    // Import utilities
    var util = require('./lib/util');

    // Import quadtree
    var quadtree= require('../../quadtree');

    var serverIndex = -1;
    var redisClient = require('redis').createClient();
    var redisPublish = require('redis').createClient();

    function Server() {
        this.args = {x : 0, y : 0, h : c.gameHeight, w : c.gameWidth, maxChildren : 1, maxDepth : 5};
        console.log(this.args);

        this.tree = quadtree.QUAD.init(this.args);

        this.users = [];
        this.massFood = [];
        this.food = [];
        this.sockets = {};

        this.leaderboard = [];
        this.leaderboardChanged = false;

        this.V = SAT.Vector;
        this.C = SAT.Circle;

        this.initMassLog = util.log(c.defaultPlayerMass, c.slowBase);

        app.use(express.static(__dirname + '/../client'));

        var self = this;

        redisClient.psubscribe('*');

        io.on('connection', function (socket) {
            console.log('A user connected!', socket.handshake.query.type);

            var type = socket.handshake.query.type;
            var radius = util.massToRadius(c.defaultPlayerMass);
            var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(self.users, radius) : util.randomPosition(radius);

            var cells = [];
            var massTotal = 0;
            if(type === 'player') {
                cells = [{
                    mass: c.defaultPlayerMass,
                    x: position.x,
                    y: position.y,
                    radius: radius
                }];
                massTotal = c.defaultPlayerMass;
            }

            var currentPlayer = {
                id: socket.id,
                x: position.x,
                y: position.y,
                cells: cells,
                massTotal: massTotal,
                hue: Math.round(Math.random() * 360),
                type: type,
                lastHeartbeat: new Date().getTime(),
                target: {
                    x: 0,
                    y: 0
                }
            };

            function handlePlayerChat(data, withRedis) {
                var _sender = data.sender.replace(/(<([^>]+)>)/ig, '');
                var _message = data.message.replace(/(<([^>]+)>)/ig, '');
                var chat = {sender: _sender, message: _message.substring(0,35)};
                if (c.logChat === 1) {
                    console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + _sender + ': ' + _message);
                }
                if (withRedis) {
                    socket.broadcast.emit('serverSendPlayerChat', chat);
                    // Publish chat to redis
                    console.log("SERVER #" + self.serverIndex + " published chat");
                    redisPublish.publish('server:' + self.serverIndex + ':SharePlayerChat', JSON.stringify(chat));
                } else {
                    socket.emit('serverSendPlayerChat', chat);
                }
            }

            redisClient.on('pmessage', function(pattern, channel, data){
                //if (pattern == 'server:*:serverSendPlayerChat') {
                    console.log("Server " + self.serverIndex + " received");
                    var match = channel.match(/server:(\d+):SharePlayerChat/);
                    var chat = JSON.parse(data);
                    if (match !== null) {
                        var emittedServer = parseInt(match[1]);
                        console.log("I am #" + self.serverIndex + " received from #" + emittedServer + " with data: ");
                        if (emittedServer != self.serverIndex) {
                            console.log(chat);
                            handlePlayerChat(chat, false);
                        }
                    }
                //}
            });

            socket.on('gotit', function (player) {
                console.log('Player ' + player.id + ' connecting');

                if (util.findIndex(self.users, player.id) > -1) {
                    console.log('That playerID is already connected, kicking');
                    socket.disconnect();
                } else if (!util.validNick(player.name)) {
                    socket.emit('kick', 'Invalid username');
                    socket.disconnect();
                } else {
                    console.log('Player ' + player.id + ' connected!');
                    self.sockets[player.id] = socket;

                    var radius = util.massToRadius(c.defaultPlayerMass);
                    var position = c.newPlayerInitialPosition == 'farthest' ? util.uniformPosition(self.users, radius) : util.randomPosition(radius);

                    player.x = position.x;
                    player.y = position.y;
                    player.target.x = 0;
                    player.target.y = 0;
                    if(type === 'player') {
                        player.cells = [{
                            mass: c.defaultPlayerMass,
                            x: position.x,
                            y: position.y,
                            radius: radius
                        }];
                        player.massTotal = c.defaultPlayerMass;
                    }
                    else {
                         player.cells = [];
                         player.massTotal = 0;
                    }
                    player.hue = Math.round(Math.random() * 360);
                    currentPlayer = player;
                    currentPlayer.lastHeartbeat = new Date().getTime();
                    self.users.push(currentPlayer);

                    io.emit('playerJoin', { name: currentPlayer.name });

                    socket.emit('gameSetup', {
                        gameWidth: c.gameWidth,
                        gameHeight: c.gameHeight
                    });
                    console.log('Total player: ' + self.users.length);
                }

            });

            socket.on('ping', function () {
                socket.emit('pong');
            });

            socket.on('windowResized', function (data) {
                currentPlayer.screenWidth = data.screenWidth;
                currentPlayer.screenHeight = data.screenHeight;
            });

            socket.on('respawn', function () {
                if (util.findIndex(self.users, currentPlayer.id) > -1)
                    self.users.splice(util.findIndex(self.users, currentPlayer.id), 1);
                socket.emit('welcome', currentPlayer);
                console.log('User #' + currentPlayer.id + ' respawned');
            });

            socket.on('disconnect', function () {
                if (util.findIndex(self.users, currentPlayer.id) > -1)
                    self.users.splice(util.findIndex(self.users, currentPlayer.id), 1);
                console.log('User #' + currentPlayer.id + ' disconnected');

                socket.broadcast.emit('playerDisconnect', { name: currentPlayer.name });
            });

            socket.on('playerChat', function(data) {
                handlePlayerChat(data, true);
            });

            socket.on('pass', function(data) {
                if (data[0] === c.adminPass) {
                    console.log(currentPlayer.name + ' just logged in as an admin');
                    socket.emit('serverMSG', 'Welcome back ' + currentPlayer.name);
                    socket.broadcast.emit('serverMSG', currentPlayer.name + ' just logged in as admin!');
                    currentPlayer.admin = true;
                } else {
                    console.log(currentPlayer.name + ' sent incorrect admin password');
                    socket.emit('serverMSG', 'Password incorrect attempt logged.');
                    // TODO actually log incorrect passwords
                }
            });

            socket.on('kick', function(data) {
                if (currentPlayer.admin) {
                    var reason = '';
                    var worked = false;
                    for (var e = 0; e < users.length; e++) {
                        if (self.users[e].name === data[0] && !self.users[e].admin && !worked) {
                            if (data.length > 1) {
                                for (var f = 1; f < data.length; f++) {
                                    if (f === data.length) {
                                        reason = reason + data[f];
                                    }
                                    else {
                                        reason = reason + data[f] + ' ';
                                    }
                                }
                            }
                            if (reason !== '') {
                               console.log('User ' + self.users[e].name + ' kicked successfully by ' + currentPlayer.name + ' for reason ' + reason);
                            }
                            else {
                               console.log('User ' + self.users[e].name + ' kicked successfully by ' + currentPlayer.name);
                            }
                            socket.emit('serverMSG', 'User ' + self.users[e].name + ' was kicked by ' + currentPlayer.name);
                            self.sockets[self.users[e].id].emit('kick', reason);
                            self.sockets[self.users[e].id].disconnect();
                            self.users.splice(e, 1);
                            worked = true;
                        }
                    }
                    if (!worked) {
                        socket.emit('serverMSG', 'Could not find user or user is admin');
                    }
                } else {
                    console.log(currentPlayer.name + ' is trying to use -kick but isn\'t admin');
                    socket.emit('serverMSG', 'You are not permitted to use this command');
                }
            });

            // Heartbeat function, update everytime
            socket.on('0', function(target) {
                currentPlayer.lastHeartbeat = new Date().getTime();
                if (target.x !== currentPlayer.x || target.y !== currentPlayer.y) {
                    currentPlayer.target = target;
                }
            });

            socket.on('1', function() {
                for(var i=0; i<currentPlayer.cells.length; i++)
                {
                    if(((currentPlayer.cells[i].mass >= c.defaultPlayerMass + c.fireFood) && c.fireFood > 0) || (currentPlayer.cells[i].mass >= 20 && c.fireFood === 0)){
                        var masa = 1;
                        if(c.fireFood > 0)
                            masa = c.fireFood;
                        else
                            masa = currentPlayer.cells[i].mass*0.1;
                        currentPlayer.cells[i].mass -= masa;
                        currentPlayer.massTotal -=masa;
                        massFood.push({
                            id: currentPlayer.id,
                            num: i,
                            masa: masa,
                            hue: currentPlayer.hue,
                            target: {
                                x: currentPlayer.x - currentPlayer.cells[i].x + currentPlayer.target.x,
                                y: currentPlayer.y - currentPlayer.cells[i].y + currentPlayer.target.y
                            },
                            x: currentPlayer.cells[i].x,
                            y: currentPlayer.cells[i].y,
                            radius: util.massToRadius(masa),
                            speed: 25
                        });
                    }
                }
            });
            socket.on('2', function() {
                //Split cells
                if(currentPlayer.cells.length < c.limitSplit && currentPlayer.massTotal >= c.defaultPlayerMass*2) {
                    var numMax = currentPlayer.cells.length;
                    for(var d=0; d<numMax; d++) {
                        if(currentPlayer.cells[d].mass >= c.defaultPlayerMass*2) {
                            currentPlayer.cells[d].mass = currentPlayer.cells[d].mass/2;
                            currentPlayer.cells[d].radius = util.massToRadius(currentPlayer.cells[d].mass);
                            currentPlayer.cells.push({
                                mass: currentPlayer.cells[d].mass,
                                x: currentPlayer.cells[d].x,
                                y: currentPlayer.cells[d].y,
                                radius: currentPlayer.cells[d].radius,
                                speed: 25
                            });
                        }
                    }
                    currentPlayer.lastSplit = new Date().getTime();
                }
            });
        });
    }

    Server.prototype.addFood = function(toAdd) {
        var radius = util.massToRadius(c.foodMass);
        while (toAdd--) {
            var position = c.foodUniformDisposition ? util.uniformPosition(food, radius) : util.randomPosition(radius);
            if(typeof(position) == "undefined")
                position = util.randomPosition(radius);
            food.push({
                // make ids unique
                id: ((new Date()).getTime() + '' + food.length) >>> 0,
                x: position.x,
                y: position.y,
                radius: radius,
                mass: Math.random() + 2,
                hue: Math.round(Math.random() * 360),
                sides: 5 + Math.round(Math.random() * 3)
            });
        }
    };

    Server.prototype.removeFood = function(toRem) {
        while (toRem--) {
            food.pop();
        }
    };

    Server.prototype.movePlayer = function(player) {
        var x =0,y =0;
        for(var i=0; i<player.cells.length; i++)
        {
            var target = {
                x: player.x - player.cells[i].x + player.target.x,
                y: player.y - player.cells[i].y + player.target.y
            };
            var dist = Math.sqrt(Math.pow(target.y, 2) + Math.pow(target.x, 2));
            var deg = Math.atan2(target.y, target.x);
            var slowDown = 1;
            if(player.cells[i].speed <= 6.25) {
                slowDown = util.log(player.cells[i].mass, c.slowBase) - initMassLog + 1;
            }

            var deltaY = player.cells[i].speed * Math.sin(deg)/ slowDown;
            var deltaX = player.cells[i].speed * Math.cos(deg)/ slowDown;

            if(player.cells[i].speed > 6.25) {
                player.cells[i].speed -= 0.5;
            }
            if (dist < (50 + player.cells[i].radius)) {
                deltaY *= dist / (50 + player.cells[i].radius);
                deltaX *= dist / (50 + player.cells[i].radius);
            }
            if (!isNaN(deltaY)) {
                player.cells[i].y += deltaY;
            }
            if (!isNaN(deltaX)) {
                player.cells[i].x += deltaX;
            }
            //Find best solution
            for(var j=0; j<player.cells.length; j++) {
                if(j != i) {
                    var distance = Math.sqrt(Math.pow(player.cells[j].y-player.cells[i].y,2) + Math.pow(player.cells[j].x-player.cells[i].x,2));
                    var radiusTotal = (player.cells[i].radius + player.cells[j].radius);
                    if(distance < radiusTotal) {
                        if(player.lastSplit > new Date().getTime() - 1000 * c.mergeTimer) {
                            if(player.cells[i].x < player.cells[j].x) {
                                player.cells[i].x--;
                            } else if(player.cells[i].x > player.cells[j].x) {
                                player.cells[i].x++;
                            }
                            if(player.cells[i].y < player.cells[j].y) {
                                player.cells[i].y--;
                            } else if((player.cells[i].y > player.cells[j].y)) {
                                player.cells[i].y++;
                            }
                        }
                        else if(distance < radiusTotal / 1.75) {
                            player.cells[i].mass += player.cells[j].mass;
                            player.cells[i].radius = util.massToRadius(player.cells[i].mass);
                            player.cells = player.cells.splice(j, 1);
                        }
                    }
                }
            }
            if(player.cells.length > i) {
                var borderCalc = player.cells[i].radius / 3;
                if (player.cells[i].x > c.gameWidth - borderCalc) {
                    player.cells[i].x = c.gameWidth - borderCalc;
                }
                if (player.cells[i].y > c.gameHeight - borderCalc) {
                    player.cells[i].y = c.gameHeight - borderCalc;
                }
                if (player.cells[i].x < borderCalc) {
                    player.cells[i].x = borderCalc;
                }
                if (player.cells[i].y < borderCalc) {
                    player.cells[i].y = borderCalc;
                }
                x += player.cells[i].x;
                y += player.cells[i].y;
            }
        }
        player.x = x/player.cells.length;
        player.y = y/player.cells.length;
    };

    Server.prototype.moveMass = function(mass) {
        var deg = Math.atan2(mass.target.y, mass.target.x);
        var deltaY = mass.speed * Math.sin(deg);
        var deltaX = mass.speed * Math.cos(deg);

        mass.speed -= 0.5;
        if(mass.speed < 0) {
            mass.speed = 0;
        }
        if (!isNaN(deltaY)) {
            mass.y += deltaY;
        }
        if (!isNaN(deltaX)) {
            mass.x += deltaX;
        }

        var borderCalc = mass.radius + 5;

        if (mass.x > c.gameWidth - borderCalc) {
            mass.x = c.gameWidth - borderCalc;
        }
        if (mass.y > c.gameHeight - borderCalc) {
            mass.y = c.gameHeight - borderCalc;
        }
        if (mass.x < borderCalc) {
            mass.x = borderCalc;
        }
        if (mass.y < borderCalc) {
            mass.y = borderCalc;
        }
    };

    Server.prototype.balanceMass = function() {
        var totalMass = food.length * c.foodMass +
            self.users
                .map(function(u) {return u.massTotal; })
                .reduce(function(pu,cu) { return pu+cu;}, 0);

        var massDiff = c.gameMass - totalMass;
        var maxFoodDiff = c.maxFood - food.length;
        var foodDiff = parseInt(massDiff / c.foodMass) - maxFoodDiff;
        var foodToAdd = Math.min(foodDiff, maxFoodDiff);
        var foodToRemove = -Math.max(foodDiff, maxFoodDiff);

        if (foodToAdd > 0) {
            //console.log('adding ' + foodToAdd + ' food to level');
            addFood(foodToAdd);
            //console.log('mass rebalanced');
        }
        else if (foodToRemove > 0) {
            //console.log('removing ' + foodToRemove + ' food from level');
            removeFood(foodToRemove);
            //console.log('mass rebalanced');
        }
    };

    Server.prototype.tickPlayer = function(currentPlayer) {
        var self = this;

        if(currentPlayer.lastHeartbeat < new Date().getTime() - c.maxHeartbeatInterval) {
            self.sockets[currentPlayer.id].emit('kick', 'Last heartbeat received over ' + c.maxHeartbeatInterval + ' ago.');
            self.sockets[currentPlayer.id].disconnect();
        }

        movePlayer(currentPlayer);

        function funcFood(f) {
            return SAT.pointInCircle(new V(f.x, f.y), playerCircle);
        }

        function deleteFood(f) {
            food[f] = {};
            food.splice(f, 1);
        }

        function eatMass(m) {
            if(SAT.pointInCircle(new V(m.x, m.y), playerCircle)){
                if(m.id == currentPlayer.id && m.speed > 0 && z == m.num)
                    return false;
                if(currentCell.mass > m.masa * 1.1)
                    return true;
            }
            return false;
        }

        function check(user) {
            for(var i=0; i<user.cells.length; i++) {
                if(user.cells[i].mass > 10 && user.id !== currentPlayer.id) {
                    var response = new SAT.Response();
                    var collided = SAT.testCircleCircle(playerCircle,
                        new C(new V(user.cells[i].x, user.cells[i].y), user.cells[i].radius),
                        response);
                    if (collided) {
                        response.aUser = currentCell;
                        response.bUser = {
                            id: user.id,
                            name: user.name,
                            x: user.cells[i].x,
                            y: user.cells[i].y,
                            num: i,
                            mass: user.cells[i].mass
                        };
                        playerCollisions.push(response);
                    }
                }
            }
        }

        function collisionCheck(collision) {
            if (collision.aUser.mass > collision.bUser.mass * 1.1  && collision.aUser.radius > Math.sqrt(Math.pow(collision.aUser.x - collision.bUser.x, 2) + Math.pow(collision.aUser.y - collision.bUser.y, 2))*1.75) {
                console.log('KILLING USER: ' + collision.bUser.id);
                console.log('collision info:');
                console.log(collision);

                var numUser = util.findIndex(users, collision.bUser.id);
                if (numUser > -1) {
                    if(self.users[numUser].cells.length > 1) {
                        self.users[numUser].massTotal -= collision.bUser.mass;
                        self.users[numUser].cells.splice(collision.bUser.num, 1);
                    } else {
                        self.users.splice(numUser, 1);
                        io.emit('playerDied', { name: collision.bUser.name });
                        self.sockets[collision.bUser.id].emit('RIP');
                    }
                }
                currentPlayer.massTotal += collision.bUser.mass;
                collision.aUser.mass += collision.bUser.mass;
            }
        }

        for(var z=0; z<currentPlayer.cells.length; z++) {
            var currentCell = currentPlayer.cells[z];
            var playerCircle = new C(
                new V(currentCell.x, currentCell.y),
                currentCell.radius
            );

            var foodEaten = food.map(funcFood)
                .reduce( function(a, b, c) { return b ? a.concat(c) : a; }, []);

            foodEaten.forEach(deleteFood);

            var massEaten = massFood.map(eatMass)
                .reduce(function(a, b, c) {return b ? a.concat(c) : a; }, []);

            var masaGanada = 0;
            for(var m=0; m<massEaten.length; m++) {
                masaGanada += massFood[massEaten[m]].masa;
                massFood[massEaten[m]] = {};
                massFood.splice(massEaten[m],1);
                for(var n=0; n<massEaten.length; n++) {
                    if(massEaten[m] < massEaten[n]) {
                        massEaten[n]--;
                    }
                }
            }

            if(typeof(currentCell.speed) == "undefined")
                currentCell.speed = 6.25;
            masaGanada += (foodEaten.length * c.foodMass);
            currentCell.mass += masaGanada;
            currentPlayer.massTotal += masaGanada;
            currentCell.radius = util.massToRadius(currentCell.mass);
            playerCircle.r = currentCell.radius;

            tree.clear();
            tree.insert(users);
            var playerCollisions = [];

            var otherUsers =  tree.retrieve(currentPlayer, check);

            playerCollisions.forEach(collisionCheck);
        }
    };

    Server.prototype.moveloop = function() {
        var self = this;
        if (self.users !== undefined) {
            for (var i = 0; i < self.users.length; i++) {
                tickPlayer(self.users[i]);
            }
        }
        if (self.massFood !== undefined) {
            for (var j = 0; j < self.massFood.length; j++) {
                if(self.massFood[j].speed > 0) moveMass(self.massFood[j]);
            }
        }
    };

    Server.prototype.gameloop = function() {
        var self = this;
        if (self.users !== undefined) {
            if (self.users.length > 0) {
                self.users.sort( function(a, b) { return b.massTotal - a.massTotal; });

                var topUsers = [];

                for (var i = 0; i < Math.min(10, self.users.length); i++) {
                    if(self.users[i].type == 'player') {
                        topUsers.push({
                            id: self.users[i].id,
                            name: self.users[i].name
                        });
                    }
                }
                if (isNaN(leaderboard) || leaderboard.length !== topUsers.length) {
                    leaderboard = topUsers;
                    leaderboardChanged = true;
                }
                else {
                    for (i = 0; i < leaderboard.length; i++) {
                        if (leaderboard[i].id !== topUsers[i].id) {
                            leaderboard = topUsers;
                            leaderboardChanged = true;
                            break;
                        }
                    }
                }
                for (i = 0; i < self.users.length; i++) {
                    for(var z=0; z < self.users[i].cells.length; z++) {
                        if (self.users[i].cells[z].mass * (1 - (c.massLossRate / 1000)) > c.defaultPlayerMass) {
                            var massLoss = users[i].cells[z].mass * (1 - (c.massLossRate / 1000));
                            self.users[i].massTotal -= self.users[i].cells[z].mass - massLoss;
                            self.users[i].cells[z].mass = massLoss;
                        }
                    }
                }
            }
            self.balanceMass();
        }
    };

    Server.prototype.sendUpdates = function() {
        var self = this;
        if (self.users !== undefined) {
            self.users.forEach( function(u) {
                // center the view if x/y is undefined, this will happen for spectators
                u.x = u.x || c.gameWidth / 2;
                u.y = u.y || c.gameHeight / 2;

                var visibleFood  = food
                    .map(function(f) {
                        if ( f.x > u.x - u.screenWidth/2 - 20 &&
                            f.x < u.x + u.screenWidth/2 + 20 &&
                            f.y > u.y - u.screenHeight/2 - 20 &&
                            f.y < u.y + u.screenHeight/2 + 20) {
                            return f;
                        }
                    })
                    .filter(function(f) { return f; });

                var visibleMass = massFood
                    .map(function(f) {
                        if ( f.x+f.radius > u.x - u.screenWidth/2 - 20 &&
                            f.x-f.radius < u.x + u.screenWidth/2 + 20 &&
                            f.y+f.radius > u.y - u.screenHeight/2 - 20 &&
                            f.y-f.radius < u.y + u.screenHeight/2 + 20) {
                            return f;
                        }
                    })
                    .filter(function(f) { return f; });

                var visibleCells  = self.users
                    .map(function(f) {
                        for(var z=0; z<f.cells.length; z++)
                        {
                            if ( f.cells[z].x+f.cells[z].radius > u.x - u.screenWidth/2 - 20 &&
                                f.cells[z].x-f.cells[z].radius < u.x + u.screenWidth/2 + 20 &&
                                f.cells[z].y+f.cells[z].radius > u.y - u.screenHeight/2 - 20 &&
                                f.cells[z].y-f.cells[z].radius < u.y + u.screenHeight/2 + 20) {
                                z = f.cells.lenth;
                                if(f.id !== u.id) {
                                    return {
                                        id: f.id,
                                        x: f.x,
                                        y: f.y,
                                        cells: f.cells,
                                        massTotal: Math.round(f.massTotal),
                                        hue: f.hue,
                                        name: f.name
                                    };
                                } else {
                                    //console.log("Nombre: " + f.name + " Es Usuario");
                                    return {
                                        x: f.x,
                                        y: f.y,
                                        cells: f.cells,
                                        massTotal: Math.round(f.massTotal),
                                        hue: f.hue,
                                    };
                                }
                            }
                        }
                    })
                    .filter(function(f) { return f; });

                self.sockets[u.id].emit('serverTellPlayerMove', visibleCells, visibleFood, visibleMass);
                if (leaderboardChanged) {
                    self.sockets[u.id].emit('leaderboard', {
                        players: self.users.length,
                        leaderboard: leaderboard
                    });
                }
            });
            leaderboardChanged = false;
        }
    };

    Server.prototype.start = function(serverIndex) {
        this.serverIndex = serverIndex;

        setInterval(this.moveloop, 1000 / 60);
        setInterval(this.gameloop, 1000);
        setInterval(this.sendUpdates, 1000 / c.networkUpdateFactor);

        // Don't touch on ip
        var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || '127.0.0.1';
        var serverport = (process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || c.port) + serverIndex;
        if (process.env.OPENSHIFT_NODEJS_IP !== undefined) {
            http.listen( serverport, ipaddress, function() {
                console.log('listening on *:' + serverport);
            });
        } else {
            http.listen( serverport, function() {
                console.log('listening on *:' + serverport);
            });
        }
    };

    module.exports = Server;

})();
