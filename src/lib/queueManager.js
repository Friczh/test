'use strict';

class GuildQueue {
  constructor(guildId) {
    this.guildId = guildId;
    /** @type {Array<object>} */
    this.tracks = [];
    this.playing = null;
    // Bumped on every skip/leave/clear-on-disconnect so an in-flight
    // extraction that was already running for a track can detect it's
    // stale and avoid clobbering whatever plays next.
    this.generation = 0;
    this.voiceChannelId = null;
    this.textChannelId = null;
  }

  add(track) {
    this.tracks.push(track);
    return this.tracks.length;
  }

  /** Batch-append (e.g. a resolved playlist) in one synchronous op. */
  addMany(tracks) {
    this.tracks.push(...tracks);
    return this.tracks.length;
  }

  next() {
    this.playing = this.tracks.shift() ?? null;
    return this.playing;
  }

  remove(index) {
    if (index < 0 || index >= this.tracks.length) return null;
    return this.tracks.splice(index, 1)[0];
  }

  swap(indexA, indexB) {
    if (
      indexA < 0 || indexA >= this.tracks.length ||
      indexB < 0 || indexB >= this.tracks.length
    ) {
      return false;
    }
    [this.tracks[indexA], this.tracks[indexB]] = [this.tracks[indexB], this.tracks[indexA]];
    return true;
  }

  move(fromIndex, toIndex) {
    if (
      fromIndex < 0 || fromIndex >= this.tracks.length ||
      toIndex < 0 || toIndex >= this.tracks.length
    ) {
      return false;
    }
    const [track] = this.tracks.splice(fromIndex, 1);
    this.tracks.splice(toIndex, 0, track);
    return true;
  }

  clear() {
    this.tracks = [];
  }

  list() {
    return [...this.tracks];
  }

  bumpGeneration() {
    this.generation += 1;
    return this.generation;
  }

  isCurrentGeneration(gen) {
    return gen === this.generation;
  }
}

class QueueManager {
  constructor() {
    /** @type {Map<string, GuildQueue>} */
    this.queues = new Map();
  }

  get(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, new GuildQueue(guildId));
    }
    return this.queues.get(guildId);
  }

  delete(guildId) {
    this.queues.delete(guildId);
  }

  has(guildId) {
    return this.queues.has(guildId);
  }
}

module.exports = { QueueManager, GuildQueue };
