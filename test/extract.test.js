'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyInput, resolveQuery, resolvePlaylistTracks } = require('../src/lib/extract');

// --- classifyInput --------------------------------------------------------

test('classifyInput: plain YouTube watch URL -> video', () => {
  const r = classifyInput('https://www.youtube.com/watch?v=abc123');
  assert.deepEqual(r, { kind: 'video', videoId: 'abc123', isMusic: false });
});

test('classifyInput: youtu.be short URL -> video', () => {
  const r = classifyInput('https://youtu.be/abc123');
  assert.deepEqual(r, { kind: 'video', videoId: 'abc123', isMusic: false });
});

test('classifyInput: shorts URL -> video', () => {
  const r = classifyInput('https://www.youtube.com/shorts/abc123');
  assert.deepEqual(r, { kind: 'video', videoId: 'abc123', isMusic: false });
});

test('classifyInput: playlist URL (no anchor video) -> playlist', () => {
  const r = classifyInput('https://www.youtube.com/playlist?list=PLabc123');
  assert.deepEqual(r, { kind: 'playlist', playlistId: 'PLabc123', isMusic: false });
});

test('classifyInput: watch URL with a real playlist list param -> playlist, not video', () => {
  const r = classifyInput('https://www.youtube.com/watch?v=abc123&list=PLxyz789');
  assert.deepEqual(r, { kind: 'playlist', playlistId: 'PLxyz789', isMusic: false });
});

test('classifyInput: music.youtube.com playlist URL -> playlist with isMusic true', () => {
  const r = classifyInput('https://music.youtube.com/playlist?list=PLmusic1');
  assert.deepEqual(r, { kind: 'playlist', playlistId: 'PLmusic1', isMusic: true });
});

test('classifyInput: radio/mix URL with an anchor video -> video, not playlist', () => {
  const r = classifyInput('https://www.youtube.com/watch?v=anchor1&list=RDanchor1');
  assert.deepEqual(r, { kind: 'video', videoId: 'anchor1', isMusic: false });
});

test('classifyInput: radio/mix URL without an anchor video -> unsupported', () => {
  const r = classifyInput('https://www.youtube.com/watch?list=RDsomething');
  assert.deepEqual(r, { kind: 'unsupported', reason: 'radio_without_anchor' });
});

test('classifyInput: non-YouTube URL -> search', () => {
  const r = classifyInput('https://example.com/not-youtube');
  assert.deepEqual(r, { kind: 'search', query: 'https://example.com/not-youtube' });
});

test('classifyInput: plain text -> search', () => {
  const r = classifyInput('some great song');
  assert.deepEqual(r, { kind: 'search', query: 'some great song' });
});

test('classifyInput: trims whitespace on search fallback', () => {
  const r = classifyInput('  some great song  ');
  assert.deepEqual(r, { kind: 'search', query: 'some great song' });
});

// --- resolveQuery -----------------------------------------------------

test('resolveQuery: a plain YouTube URL calls session.getBasicInfo(), not session.music.getInfo()', async () => {
  const calls = [];
  const session = {
    getBasicInfo: async (id) => {
      calls.push(['getBasicInfo', id]);
      return { basic_info: { title: 'A Video' } };
    },
    music: {
      getInfo: async (id) => {
        calls.push(['music.getInfo', id]);
        return { basic_info: { title: 'wrong path' } };
      },
    },
  };

  const result = await resolveQuery(session, 'https://www.youtube.com/watch?v=abc123');
  assert.deepEqual(calls, [['getBasicInfo', 'abc123']]);
  assert.deepEqual(result, { videoId: 'abc123', isMusic: false, title: 'A Video' });
});

test('resolveQuery: a music.youtube.com URL calls session.music.getInfo(), not session.getBasicInfo()', async () => {
  // Regression test: session.getBasicInfo()/getInfo() hardcode a parse into
  // VideoInfo (`.as(TwoColumnWatchNextResults)`), which throws on a YTMUSIC
  // watch response (SingleColumnMusicWatchNextResults) regardless of the
  // session's client_type. Calling the wrong method here is exactly the bug
  // that broke /play for YTM songs in production.
  const calls = [];
  const session = {
    getBasicInfo: async (id) => {
      calls.push(['getBasicInfo', id]);
      throw new Error('would throw: Cannot cast SingleColumnMusicWatchNextResults');
    },
    music: {
      getInfo: async (id) => {
        calls.push(['music.getInfo', id]);
        return { basic_info: { title: 'A Song' } };
      },
    },
  };

  const result = await resolveQuery(session, 'https://music.youtube.com/watch?v=xyz789');
  assert.deepEqual(calls, [['music.getInfo', 'xyz789']]);
  assert.deepEqual(result, { videoId: 'xyz789', isMusic: true, title: 'A Song' });
});

test('resolveQuery: falls back to videoId when title is missing', async () => {
  const session = { getBasicInfo: async () => ({ basic_info: {} }) };
  const result = await resolveQuery(session, 'https://youtu.be/noTitle1');
  assert.equal(result.title, 'noTitle1');
});

test('resolveQuery: a free-text query searches and takes the first video result', async () => {
  const { YTNodes } = require('youtubei.js');
  const fakeVideo = Object.create(YTNodes.Video.prototype);
  fakeVideo.video_id = 'searched1';
  fakeVideo.title = { text: 'Searched Song' };

  const session = {
    search: async (query, filters) => {
      assert.equal(query, 'some great song');
      assert.deepEqual(filters, { type: 'video' });
      return { results: { firstOfType: () => fakeVideo } };
    },
  };

  const result = await resolveQuery(session, 'some great song');
  assert.deepEqual(result, { videoId: 'searched1', isMusic: false, title: 'Searched Song' });
});

test('resolveQuery: throws when a search finds nothing', async () => {
  const session = { search: async () => ({ results: { firstOfType: () => undefined } }) };
  await assert.rejects(() => resolveQuery(session, 'no results for this'), /No results found/);
});



function fakeYouTubePage(items, hasContinuation, nextPage) {
  return {
    items: Object.assign([...items], { filterType: () => items }),
    has_continuation: hasContinuation,
    getContinuation: async () => nextPage,
  };
}

test('resolvePlaylistTracks (YouTube): paginates across continuations', async () => {
  const page2 = fakeYouTubePage(
    [{ id: 'v4', title: { text: 'Track 4' }, is_playable: true }],
    false,
    null
  );
  const page1 = fakeYouTubePage(
    [
      { id: 'v1', title: { text: 'Track 1' }, is_playable: true },
      { id: 'v2', title: { text: 'Track 2' }, is_playable: true },
    ],
    true,
    page2
  );
  const session = { getPlaylist: async () => page1 };

  const tracks = await resolvePlaylistTracks(session, 'PLabc', false);
  assert.deepEqual(
    tracks.map((t) => t.videoId),
    ['v1', 'v2', 'v4']
  );
  assert.equal(tracks.every((t) => t.isMusic === false), true);
});

test('resolvePlaylistTracks (YouTube): skips items where is_playable is false', async () => {
  const page1 = fakeYouTubePage(
    [
      { id: 'v1', title: { text: 'Track 1' }, is_playable: true },
      { id: 'v2', title: { text: 'Unavailable' }, is_playable: false },
      { id: 'v3', title: { text: 'Track 3' }, is_playable: true },
    ],
    false,
    null
  );
  const session = { getPlaylist: async () => page1 };

  const tracks = await resolvePlaylistTracks(session, 'PLabc', false);
  assert.deepEqual(
    tracks.map((t) => t.videoId),
    ['v1', 'v3']
  );
});

test('resolvePlaylistTracks (YouTube): respects maxTracks and stops paginating once hit', async () => {
  const page2 = fakeYouTubePage(
    [{ id: 'v4', title: { text: 'Track 4' }, is_playable: true }],
    false,
    null
  );
  let page2Fetched = false;
  page2.getContinuation = async () => {
    page2Fetched = true;
    return null;
  };
  const page1 = fakeYouTubePage(
    [
      { id: 'v1', title: { text: 'Track 1' }, is_playable: true },
      { id: 'v2', title: { text: 'Track 2' }, is_playable: true },
      { id: 'v3', title: { text: 'Track 3' }, is_playable: true },
    ],
    true,
    page2
  );
  const session = { getPlaylist: async () => page1 };

  const tracks = await resolvePlaylistTracks(session, 'PLabc', false, { maxTracks: 2 });
  assert.deepEqual(
    tracks.map((t) => t.videoId),
    ['v1', 'v2']
  );
  assert.equal(page2Fetched, false); // shouldn't paginate further once the cap is hit
});

test('resolvePlaylistTracks (YouTube Music): uses item_type/id instead of is_playable', async () => {
  const musicPage = {
    items: Object.assign(
      [
        { id: 'm1', title: 'Song 1', item_type: 'song' },
        { id: undefined, title: 'Broken', item_type: 'song' }, // no id -> skip
        { id: 'm2', title: 'Song 2', item_type: 'video' },
        { id: 'm3', title: 'Not a track', item_type: 'album' }, // wrong type -> skip
      ],
      {
        filterType: function () {
          return this;
        },
      }
    ),
    has_continuation: false,
    getContinuation: async () => null,
  };
  const session = { music: { getPlaylist: async () => musicPage } };

  const tracks = await resolvePlaylistTracks(session, 'PLmusic', true);
  assert.deepEqual(
    tracks.map((t) => t.videoId),
    ['m1', 'm2']
  );
  assert.equal(tracks.every((t) => t.isMusic === true), true);
});

test('resolvePlaylistTracks: an empty playlist resolves to an empty array', async () => {
  const page1 = fakeYouTubePage([], false, null);
  const session = { getPlaylist: async () => page1 };
  const tracks = await resolvePlaylistTracks(session, 'PLempty', false);
  assert.deepEqual(tracks, []);
});
