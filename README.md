# tiwo.github.io/share

This is going to be a statically hosted, serverless(*) peer-to-peer chat, file sharing, and camera sharing website.

- When browser B1 loads this website at $baseurl, the user sees a checklist. The checklist follow along the lines of the following itemization.

- B1 will generate a secret 144-bit key using the web crypto api. We'll refer to the url-save encoded key (using base64) as $K

- the URL with URL fragmen $baseurl#$K is then displayed as a QR code.

- B1 derives from $K a peer id for use with PeerJS.

- It then waits for incoming connections (via PeerJS).


- When a different browser B2 now loads that URL, it sees from the URL fragment that it is the "guest".

- B2 derives from the url fragment $K the same id as B1.

- once B1 and B2 are connected via PeerJS, the three main functions of this app are available:

- a chat window is provided for messages between both browsers.

- and a "share camera" function is included as well.

- and a "drop files to share" function is used for peer-to-peer sharing of files from one browser to the nother.


# contributing 

- write idiomatic typescript please
- place utility functions under ./src/lib/

- for the user interface, write idiomatic Vue3 (using the "script setup" composition API), use 

- use PeerJS (built on WebRTC) for the traffic itself. Adopt patterns to reconnect a lost connection.
- use QRCode.js for qr code generation.

# current status (camera-first mvp)

Implemented in this phase:

- Host/guest bootstrap via URL fragment secret.
- Deterministic room peer id derivation from the fragment secret.
- PeerJS signaling setup with strict 2-peer behavior.
- Camera sharing first (video only, no microphone yet).
- Optional two-way camera sharing (either side can start camera).
- Reconnect handling with bounded backoff.
- Share link and QR code display for guest onboarding.
- Data-channel authentication handshake (mutual HMAC challenge-response with replay checks).

Not implemented yet:

- Chat transport and UI.
- File transfer transport and UI.

# local usage

1. Start the app with `npm run dev`.
2. Open the base URL in browser A; it becomes host and creates a share link.
3. Open the share link (or scan the QR code) in browser B; it becomes guest.
4. Press `Start camera` on either side to share video.