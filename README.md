# LemonLeek WhatsApp Bot Panel

A full-stack Node.js dashboard for managing a WhatsApp session with a browser UI.

## Run

1. Install Node.js 20+.
2. Extract this project.
3. Run:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`.
5. Scan the displayed QR with WhatsApp > Linked devices.

## Features

- WhatsApp QR connection
- Persistent authentication in `auth_info/`
- Live Socket.IO status updates
- Incoming message stream
- Sending messages from the dashboard
- `/help` and `/ping` automatic replies
- Bot settings
- Activity logs
- Responsive dark dashboard

## Notes

Use this only with WhatsApp accounts you control and comply with WhatsApp's applicable terms and policies. The panel is intentionally built without bulk unsolicited messaging or evasion features.
