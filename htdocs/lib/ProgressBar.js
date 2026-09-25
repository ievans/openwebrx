ProgressBar = function(el) {
    this.$el = $(el);
    this.$innerText = $('<span class="openwebrx-progressbar-text">' + this.getDefaultText() + '</span>');
    this.$innerBar = $('<div class="openwebrx-progressbar-bar"></div>');
    this.$el.empty().append(this.$innerText, this.$innerBar);
};

ProgressBar.prototype.getDefaultText = function() {
    return '';
}

ProgressBar.prototype.set = function(val, text, over) {
    this.setValue(val);
    this.setText(text);
    this.setOver(over);
};

ProgressBar.prototype.setValue = function(val) {
    if (val < 0) val = 0;
    if (val > 1) val = 1;
    this.$innerBar.css({transform: 'translate(' + ((val - 1) * 100) + '%) translateZ(0)'});
};

ProgressBar.prototype.setText = function(text) {
    this.$innerText.html(text);
};

ProgressBar.prototype.setOver = function(over) {
    this.$el[over ? 'addClass' : 'removeClass']('openwebrx-progressbar--over');
};

AudioBufferProgressBar = function(el) {
    ProgressBar.call(this, el);
};

AudioBufferProgressBar.prototype = new ProgressBar();

AudioBufferProgressBar.prototype.getDefaultText = function() {
    return 'Audio buffer [0 ms]';
};

AudioBufferProgressBar.prototype.setSampleRate = function(sampleRate) {
    this.sampleRate = sampleRate;
};

AudioBufferProgressBar.prototype.setBuffersize = function(buffersize) {
    var audio_buffer_value = buffersize / this.sampleRate;
    var overrun = audio_buffer_value > audio_buffer_maximal_length_sec;
    var underrun = audio_buffer_value === 0;
    var text = "buffer";
    if (overrun) {
        text = "overrun";
    }
    if (underrun) {
        text = "underrun";
    }
    this.set(audio_buffer_value, "Audio " + text + " [" + (audio_buffer_value).toFixed(1) + " s]", overrun || underrun);
};


NetworkSpeedProgressBar = function(el) {
    ProgressBar.call(this, el);
};

NetworkSpeedProgressBar.prototype = new ProgressBar();

NetworkSpeedProgressBar.prototype.getDefaultText = function() {
    return 'Network usage [0 kbps]';
};

NetworkSpeedProgressBar.prototype.setSpeed = function(speed) {
    var speedInKilobits = speed * 8 / 1000;
    this.set(speedInKilobits / 2000, "Network usage [" + speedInKilobits.toFixed(1) + " kbps]", false);
};

AudioSpeedProgressBar = function(el) {
    ProgressBar.call(this, el);
};

AudioSpeedProgressBar.prototype = new ProgressBar();

AudioSpeedProgressBar.prototype.getDefaultText = function() {
    return 'Audio stream [0 kbps]';
};

AudioSpeedProgressBar.prototype.setSpeed = function(speed) {
    this.set(speed / 1000000, "Audio stream [" + (speed / 1000).toFixed(0) + " kbps]", false);
};

AudioOutputProgressBar = function(el, sampleRate) {
    ProgressBar.call(this, el);
};

AudioOutputProgressBar.prototype = new ProgressBar();

AudioOutputProgressBar.prototype.getDefaultText = function() {
    return 'Audio output [0 sps]';
};

AudioOutputProgressBar.prototype.setSampleRate = function(sampleRate) {
    this.maxRate = sampleRate * 1.25;
    this.minRate = sampleRate * .25;
};

AudioOutputProgressBar.prototype.setAudioRate = function(audioRate) {
    this.set(audioRate / this.maxRate, "Audio output [" + (audioRate / 1000).toFixed(1) + " ksps]", audioRate > this.maxRate || audioRate < this.minRate);
};

ClientsProgressBar = function(el) {
    ProgressBar.call(this, el);
    this.clients = 0;
    this.maxClients = 0;
};

ClientsProgressBar.prototype = new ProgressBar();

ClientsProgressBar.prototype.getDefaultText = function() {
    return 'Clients [1]';
};

ClientsProgressBar.prototype.setClients = function(clients) {
    this.clients = clients;
    this.render();
};

ClientsProgressBar.prototype.setMaxClients = function(maxClients) {
    this.maxClients = maxClients;
    this.render();
};

ClientsProgressBar.prototype.render = function() {
    this.set(this.clients / this.maxClients, "Clients [" + this.clients + "]", this.clients > this.maxClients * 0.85);
};

CpuProgressBar = function(el) {
    ProgressBar.call(this, el);
};

CpuProgressBar.prototype = new ProgressBar();

CpuProgressBar.prototype.getDefaultText = function() {
    return 'Server CPU [0%]';
};

CpuProgressBar.prototype.setUsage = function(usage) {
    const temp = this.temp? "/" + this.temp + "&deg;C" : "";
    this.set(usage, "Server CPU [" + Math.round(usage * 100) + "%" + temp + "]", usage > .85);
};

CpuProgressBar.prototype.setTemp = function(temp) {
    this.temp = temp;
};

BatteryProgressBar = function(el) {
    ProgressBar.call(this, el);
};

BatteryProgressBar.prototype = new ProgressBar();

BatteryProgressBar.prototype.getDefaultText = function() {
    return 'Battery';
};

BatteryProgressBar.prototype.setBattery = function(battery) {
    var voltage = battery.voltage || 0.0;
    var current = battery.current || 0.0;
    var charger = battery.charger? 'Charging' : 'Battery';
    var charge  = battery.charge || 0;

    current = current > 0? ('/' + current + 'A') : '';

    this.set(
        charge / 100.0,
        charger + ' [' + charge + '%/' + voltage + 'V' + current + ']',
        charge < 20
    );
};

// System memory use, warns when it gets high (e.g. from IQ buffers). Read from
// /proc/meminfo, so this reflects the host kernel's view of memory, not a
// figure scoped to the OpenWebRX process (e.g. the whole host when running
// in a container without its own memory cgroup limits).
MemoryProgressBar = function(el) {
    ProgressBar.call(this, el);
};

MemoryProgressBar.prototype = new ProgressBar();

MemoryProgressBar.prototype.getDefaultText = function() {
    return 'Server Memory';
};

MemoryProgressBar.prototype.setMemory = function(memory) {
    var used = memory.total? memory.used / memory.total : 0;
    var gb = function(b) { return Math.round(b / 1073741824); };
    this.set(used,
        'Server Memory [' + Math.round(100 * used) + '% ' + gb(memory.used) + '/' + gb(memory.total) + 'GB]',
        used > .85
    );
};

// Fill level of the server's IQ time-shift buffer, which allows tuning
// anywhere while replaying the waterfall history.
IqBufferProgressBar = function(el) {
    ProgressBar.call(this, el);
};

IqBufferProgressBar.prototype = new ProgressBar();

IqBufferProgressBar.prototype.getDefaultText = function() {
    return 'Playback Buffer';
};

IqBufferProgressBar.prototype.setStatus = function(status) {
    var max = status.max_seconds || 0;
    var fill = max? status.seconds / max : 0;
    var mb = function(b) { return Math.round(b / 1048576) + 'MB'; };
    this.set(fill,
        'Playback Buffer [' + Math.round(100 * fill) + '% ' + Math.round(status.seconds) + '/' + Math.round(max) + 's]',
        false
    );
    this.$el.attr('title', 'Playback buffer: ' + Math.round(status.seconds) + ' of ' + Math.round(max) +
        ' seconds at ' + (status.samp_rate / 1e6) + 'MS/s, ' + mb(status.bytes) + ' of ' + mb(status.max_bytes) +
        ' system memory' + (status.memory_limited? ' (shortened to fit the server\'s memory limit)' : '') +
        '. Within this time you can tune anywhere while replaying.');
};

ProgressBar.types = {
    iqbuffer: IqBufferProgressBar,
    memory: MemoryProgressBar,
    cpu: CpuProgressBar,
    battery: BatteryProgressBar,
    audiobuffer: AudioBufferProgressBar,
    audiospeed: AudioSpeedProgressBar,
    audiooutput: AudioOutputProgressBar,
    clients: ClientsProgressBar,
    networkspeed: NetworkSpeedProgressBar
}

$.fn.progressbar = function() {
    if (!this.data('progressbar')) {
        var constructor = ProgressBar.types[this.data('type')] || ProgressBar;
        this.data('progressbar', new constructor(this));
    }
    return this.data('progressbar');
};
