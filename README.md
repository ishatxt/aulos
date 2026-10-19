# CHESSOUND — The Sound of Chess

CHESSOUND turns a chess game into a **deterministic piano composition**. Every legal move becomes one musical event: the destination square chooses the pitch, the moving piece shapes the timbre and articulation, and captures, checks, castling, promotion and checkmate add recognisable gestures.

Everything runs in the browser. There is no backend, no account, no API key, no remote sample library and no generated audio sent anywhere.

## Run it locally

Requirements: **Node.js 20.19+ or 22.12+** (Vite 7) and a modern desktop or mobile browser with Web Audio.

```bash
npm install
npm run dev
```

Open the URL printed by Vite, normally <http://localhost:5173/>.

```bash
npm run build     # production build in dist/
npm run preview   # serve the production build
npm test          # Node test runner: mapping, game, storage and sharing
```

The first sound requires a click on **Enable sound** (or **Play**) because of browser autoplay policies. Audio is synthesized with the Web Audio API at playback time and again, independently, by the offline WAV exporter.

## What you can do

- Play a complete legal game with drag-and-drop or click-to-move, castling, en passant, promotion, checks, checkmate and draws.
- Enter moves in the keyboard field as SAN (`Nf3`, `O-O`, `exd8=Q`) or coordinates (`g1f3`, `e7e8q`).
- Import a PGN from text, a file or a CHESSOUND share code.
- Replay the composition with play, pause, stop, restart, seek, previous/next event and live tempo changes.
- Switch between **Classical**, **Cinematic**, **Ambient**, **Minimal** and **Experimental** modes.
- Fine-tune root note, scale, register, rhythm, tempo, note length, instrument intensity, master volume, reverb, voices and event flourishes.
- Watch the real AnalyserNode spectrum/waveform and a C2–C7 piano field highlight the notes actually sounding.
- Follow the synchronized board, score, timeline, now-playing panel and per-move mapping explanation.
- Save compact compositions to a local library (PGN + settings only), reopen or delete them.
- Share a link that embeds the complete PGN and every mapping setting in the URL fragment.
- Export standards-compliant PGN and a real 16-bit stereo WAV rendered with `OfflineAudioContext`.

## The mapping, precisely

The mapping is pure and deterministic: **the same PGN and the same settings always rebuild exactly the same note events**. No random values are used.

1. **Destination file → scale degree.** Files `a`–`h` map to degrees 1–8 of the selected scale.
2. **Destination rank → octave.** Ranks 1–4 use the lower half of the selected register; ranks 5–8 use the upper half.
3. **Moving piece → signature.** Pawn, knight, bishop, rook, queen and king add their own octave shift, velocity, note length and harmonic weight.
4. **Colour → voice and register.** White and Black use the selected voices; Black also sits one octave below White before the voice's own shift.
5. **Move meaning → gesture.** Captures add a diatonic third and low body, checks add a chromatic/tritone tension, castling plays a root–fifth–octave roll, promotion adds a rising flourish and checkmate closes with a tonic cadence.
6. **Settings → time and timbre.** Tempo, rhythm, note length, instrument intensity, scale, reverb and mode shape the resulting event durations and synthesis.

The **Mapping guide** in the app prints the current pitch grid, the six rules, piece signatures, mode descriptions and the exact time/colour settings in use. The guide is generated from the same mapping module that produces the notes, so the explanation cannot drift from the sound.

All notes are clamped to MIDI 24–108. The safety clamp is deliberate: extreme register/voice combinations stay audible and never produce invalid frequencies.

### Modes

| Mode | Character | Starting point |
| --- | --- | --- |
| Classical | Felt-piano recital | Major, medium register, flowing rhythm |
| Cinematic | Low strings and drama | Harmonic minor, slow and heavy |
| Ambient | Slow air and long tails | Major pentatonic, glass/velvet voices, spacious rhythm |
| Minimal | Plucks and space | Minor pentatonic, pulse/pluck voices, short gestures |
| Experimental | Chromatic study | Chromatic scale, brisk and bright |

Mode buttons apply a documented starting preset; every value remains editable afterwards.

## Playback architecture

- `CompositionPlayer` owns a beat-based clock derived from `AudioContext.currentTime`.
- Notes are scheduled only a short look-ahead window ahead, with every realtime handle tracked.
- Pause, stop, seek, event jumps and tempo changes cancel pending handles before rescheduling, so the same note is never played twice.
- Live board moves use the same note objects and audio voices as the composition player.
- Background tabs are paused rather than silently drifting out of sync.

## Local data and privacy

- Preferences are stored in `localStorage`.
- Saved compositions are compact records: title, PGN, settings, summary and timestamps. The note field is rebuilt from the PGN, which also demonstrates that the mapping is reproducible.
- The library keeps up to 20 compositions on the device.
- Share links carry data only in the URL fragment (`#c=…`). The fragment is not sent to a server. Opening a share link decodes it locally and then cleans the address bar with `history.replaceState`.
- Imported files are read locally with the File API.
- WAV rendering happens in an `OfflineAudioContext`. The file is created as a Blob and downloaded directly; nothing is uploaded.

## Browser support and limits

- Best experience: current Chrome, Edge, Firefox or Safari with Web Audio and ES modules.
- WAV export uses `OfflineAudioContext`; browsers without it show a clear error instead of a fake download.
- Browser WAV export is limited to **15 minutes per file**, including the reverb tail. Longer compositions can still be played, saved, shared and exported as PGN.
- Offline rendering and PCM encoding take real CPU time. The progress panel reports genuine stages (`preparing`, `scheduling`, `rendering`, `encoding`); it does not invent frame-by-frame percentages.
- A saved library depends on browser storage. Clearing site data removes it; use PGN, share links or WAV exports for durable copies.
- Very long games rebuild more note events. The mapping is linear and remains deterministic, but the WAV size grows with duration.
- Audio starts only after a user gesture, as required by browser autoplay policies.

## Accessibility and comfort

- Semantic landmarks, labelled controls, a skip link, visible focus rings and live-region announcements.
- Keyboard navigation for the studio (`Space` play/pause, arrows previous/next event, `Home`/`End` positions, `U` undo, `F` flip, `?` mapping guide) when focus is not in a form control or the chessboard.
- cm-chessboard's accessibility extension provides a keyboard-accessible board representation and move input.
- Reduced-motion mode removes ornamental transitions and board effects; the visualizer throttles to an honest idle rate.
- The piano field, move list and timeline all reflect the same event index as the audible playback clock.

## Project structure

```text
index.html                  Studio markup, dialogs and icon sprite
src/main.js                 Application orchestration and UI wiring
src/config.js               Settings, modes, scales, voices, sanitization
src/music-mapping.js        Deterministic chess → note-field mapping
src/chess-game.js           chess.js rules/history/PGN wrapper
src/audio-engine.js         Realtime synthesis and shared mix graph
src/composition-player.js   Beat clock, look-ahead scheduler, transport state
src/board-view.js           cm-chessboard integration and input validation
src/visualizer.js           Analyser spectrum, waveform and piano field
src/wav-export.js           OfflineAudioContext render + WAV encoder
src/storage.js              localStorage preferences and library
src/share.js                Share-code/URL encoding and decoding
src/styles.css              Complete studio visual system
public/cm-assets/           Local board CSS, markers, promotion assets, piece sprite
tests/                      Node tests for mapping, chess, storage and sharing
```

## Verification

```bash
npm test
npm run build
```

The test suite covers legal moves, castling/en passant/promotion, PGN round-trips, deterministic mapping, mode distinctness, pitch clamping, share-code round-trips, damaged-code handling and local persistence.

The app is intentionally dependency-light at runtime: `chess.js`, `cm-chessboard`, locally bundled variable fonts and the platform Web Audio API. Vite is the only build tool.

## Credits and licenses

- Chess rules and PGN parsing: [`chess.js`](https://github.com/jhlywa/chess.js) (BSD-2-Clause).
- Board rendering: [`cm-chessboard`](https://github.com/shaack/cm-chessboard) (MIT).
- Standard chess piece sprite by **Cburnett / Rfc1394**, from Wikimedia Commons, licensed **CC BY-SA 3.0**. The attribution is also shown in the site footer, and the license text is embedded in `public/cm-assets/pieces/standard.svg`.
- Newsreader, Manrope and JetBrains Mono variable fonts via Fontsource, under the SIL Open Font License 1.1.
- Music, mapping, interface and application code in this repository were created for CHESSOUND.

No remote runtime assets are required: fonts, board styles, markers and piece sprites are all bundled or served locally.
