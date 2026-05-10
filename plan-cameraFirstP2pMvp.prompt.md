## Plan: Camera-First P2P MVP

Build a camera-first vertical slice of the app with strict 2-peer sessions, optional two-way video sharing, and a styled Vue UI. Start by implementing deterministic session bootstrap from URL fragment and a reliable PeerJS data channel handshake, then add WebRTC media call flow and UI state. Keep chat/file share out of scope for this phase.

**Steps**
1. Phase 1 - Core Session Bootstrap
2. Implement URL-fragment role detection and key handling in app state: host creates key when fragment missing, guest reads key when fragment present, both compute deterministic session identifiers. *blocks steps 3-8*
3. Implement peer identity derivation + helpers in lib utilities (key encode/decode, peer id derivation constraints, random key generation).
4. Add PeerJS bootstrap service with explicit connection state machine (`INIT`, `SIGNALING`, `CONNECTED`, `RECONNECTING`, `FAILED`, `CLOSED`) and strict two-peer guardrails (reject additional incoming peers). *parallel with step 3 after shared types are defined*
5. Phase 2 - Camera Call Flow
6. Implement media utilities: request camera-only stream (`video: true, audio: false`), stop tracks cleanly, attach/detach streams to video elements.
7. Implement call orchestration via PeerJS media calls:
8. Host path: wait for incoming media call and answer with local stream only when user enabled sharing.
9. Guest path: initiate call when connected and local sharing is enabled.
10. For optional two-way behavior, allow either side to toggle “Share my camera”; when enabled post-connect, trigger outbound call (or renegotiation pattern via fresh call).
11. Add recovery hooks for call close/error/disconnect and ICE interruptions; re-attempt call using bounded backoff while peer connection remains alive. *depends on step 4*
12. Phase 3 - Styled Camera-First UI
13. Replace scaffold UI with app shell containing: session card (role, link/QR placeholder), connection status badge, local preview tile, remote video tile, and action controls (`Start camera`, `Stop camera`, `Reconnect`).
14. Add accessible permission/error messaging for camera denial, missing camera device, and peer disconnect reasons.
15. Apply a consistent production-like visual system in `src/style.css` (color tokens, spacing scale, responsive layout, clear status colors), preserving mobile/desktop behavior. *parallel with step 13 once component structure is fixed*
16. Phase 4 - Integration Hardening
17. Ensure cleanup on route unload/component unmount: destroy PeerJS instance, close active media calls, stop local tracks, clear timers/listeners.
18. Add explicit scope fences in code comments/TODOs for future chat/file modules without introducing dead code paths.

**Relevant files**
- `c:/dev/hack/share/src/App.vue` - Main orchestration for role detection, connection state, camera controls, and top-level layout.
- `c:/dev/hack/share/src/lib/crypto.ts` - Secret generation, fragment-safe encoding/decoding, deterministic peer-id derivation helpers.
- `c:/dev/hack/share/src/lib/helpers.ts` - PeerJS bootstrap, connection state transitions, retry/backoff helpers, stream attach helpers.
- `c:/dev/hack/share/src/style.css` - Styled production-like responsive visual system for camera-first interface.
- `c:/dev/hack/share/src/components/HelloWorld.vue` - Remove/retire scaffold component or repurpose as focused presentational child if needed.
- `c:/dev/hack/share/README.md` - Update implementation notes and phase-1 usage behavior.

**Verification**
1. Run typecheck/build and fix all TS errors.
2. Manual host flow: open base URL with no fragment, verify host role, generated share link, and ready state.
3. Manual guest flow: open host link in second browser/profile, verify guest role and successful peer connection.
4. Camera test A: host enables camera, guest sees remote stream; disable camera and confirm remote stream ends cleanly.
5. Camera test B: guest enables camera, host sees remote stream (two-way optional behavior).
6. Reconnect test: temporarily disable network on one side and restore; verify state transitions and bounded reconnect attempts.
7. Permissions test: deny camera permission and verify clear actionable error UI with retry option.
8. Mobile viewport test: verify controls and video tiles remain usable at narrow widths.

**Decisions**
- Included: camera-first implementation with optional two-way sharing and strict two-peer sessions.
- Excluded: chat transport, file transfer, end-to-end app-level crypto handshake, and QR rendering implementation details beyond interface placeholder in this phase.
- Assumption: existing PeerJS default cloud signaling is acceptable for MVP; TURN hardening can be added in a later phase.

**Further Considerations**
1. QR timing: render QR in this phase or keep as text link + copy button now. Recommendation: keep text/copy now, add QR immediately in next slice.
2. Call model: single active media call at a time vs separate outbound calls per sharer. Recommendation: single active call per direction with explicit replacement on toggle.
3. Browser support floor: latest Chromium/Firefox/Safari only vs broader legacy compatibility. Recommendation: latest stable browsers for MVP.