# BikerTrack — Real-time Group Ride Tracker

A mobile-friendly web app for motorcycle groups to share live locations on a map.

## Features
- Create a group → get a 6-character room code
- Invite riders by sharing the room code
- Each rider appears as a colored dot on a live map
- Set a shared destination (🏁 flag) visible to all
- Works on mobile browsers (uses device GPS)

## Setup

```bash
pip install -r requirements.txt
python app.py
```

Server runs on `http://0.0.0.0:5000`

## Usage
1. One rider opens the app and clicks **Create Group** → gets a room code like `AB12CD`
2. Other riders open the app, enter their name and the room code, click **Join**
3. All riders appear as coloured dots on the live map
4. Anyone can tap **Destination** and tap the map to set a shared destination flag
5. Use **All** to fit all riders in view, **Me** to center on yourself

## On Mobile (same Wi-Fi / LAN)
Access via `http://<your-PC-IP>:5000` on riders' phones. Allow location permission when prompted.

## Files
```
app.py              # Flask + Socket.IO backend
requirements.txt    # Python dependencies
templates/
  index.html        # Single-page app shell
static/
  style.css         # Dark mobile-first UI
  app.js            # Map, WebSocket, location logic
```
