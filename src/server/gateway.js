var SERVER_COUNT = process.env.SERVER_COUNT || 2;
var cluster = require('cluster');
var Server = require('./server');

if (cluster.isMaster) {
    // Spawn servers here
    for (var i = 0; i < SERVER_COUNT; i++) {
        var worker = cluster.fork();
        worker.send('index:' + i.toString());
        console.log('Spawned #' + i);
    }
} else {
    // Get the index from master to spawn new process
    process.on('message', function(msg) {
        var match = msg.match(/index:(\d+)/);
        if (match !== null) {
            var idx = parseInt(match[1]);
            var gameServer = new Server();
            gameServer.start(idx);
        }
    });
}
