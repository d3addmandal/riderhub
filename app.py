from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, join_room, leave_room, emit
import random
import string
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = 'biker-app-secret-2024'
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')

# In-memory state
rooms = {}  # room_id -> { riders: {sid: {...}}, destination: {...}, created_at }

RIDER_COLORS = [
    '#FF4444', '#4444FF', '#44BB44', '#FF8800', '#AA44FF',
    '#FF44AA', '#00AAFF', '#FFCC00', '#00CCAA', '#FF6644'
]


def generate_room_id():
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))


def assign_color(room_id):
    used = {r['color'] for r in rooms[room_id]['riders'].values()}
    available = [c for c in RIDER_COLORS if c not in used]
    return available[0] if available else random.choice(RIDER_COLORS)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/create_room', methods=['POST'])
def create_room():
    data = request.get_json()
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400

    room_id = generate_room_id()
    while room_id in rooms:
        room_id = generate_room_id()

    rooms[room_id] = {
        'riders': {},
        'destination': None,
        'created_at': datetime.utcnow().isoformat()
    }
    return jsonify({'room_id': room_id})


@app.route('/api/check_room/<room_id>')
def check_room(room_id):
    if room_id.upper() in rooms:
        return jsonify({'exists': True})
    return jsonify({'exists': False})


@socketio.on('join')
def on_join(data):
    room_id = data.get('room_id', '').upper()
    name = (data.get('name') or '').strip()

    if not room_id or room_id not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    if not name:
        emit('error', {'message': 'Name is required'})
        return

    color = assign_color(room_id)
    rooms[room_id]['riders'][request.sid] = {
        'name': name,
        'color': color,
        'lat': None,
        'lng': None,
        'timestamp': None
    }

    join_room(room_id)

    # Send current state to the new rider
    emit('joined', {
        'room_id': room_id,
        'color': color,
        'destination': rooms[room_id]['destination'],
        'riders': {
            sid: {k: v for k, v in r.items()}
            for sid, r in rooms[room_id]['riders'].items()
        }
    })

    # Notify others
    emit('rider_joined', {
        'sid': request.sid,
        'name': name,
        'color': color
    }, to=room_id, include_self=False)


@socketio.on('location')
def on_location(data):
    room_id = data.get('room_id', '').upper()
    if room_id not in rooms or request.sid not in rooms[room_id]['riders']:
        return

    rider = rooms[room_id]['riders'][request.sid]
    rider['lat'] = data.get('lat')
    rider['lng'] = data.get('lng')
    rider['timestamp'] = datetime.utcnow().isoformat()

    emit('location_update', {
        'sid': request.sid,
        'lat': rider['lat'],
        'lng': rider['lng'],
        'name': rider['name'],
        'color': rider['color'],
        'timestamp': rider['timestamp']
    }, to=room_id, include_self=False)


@socketio.on('set_destination')
def on_set_destination(data):
    room_id = data.get('room_id', '').upper()
    if room_id not in rooms or request.sid not in rooms[room_id]['riders']:
        return

    dest = {'lat': data.get('lat'), 'lng': data.get('lng'), 'name': data.get('name', 'Destination')}
    rooms[room_id]['destination'] = dest

    emit('destination_updated', dest, to=room_id)


@socketio.on('clear_destination')
def on_clear_destination(data):
    room_id = data.get('room_id', '').upper()
    if room_id not in rooms or request.sid not in rooms[room_id]['riders']:
        return
    rooms[room_id]['destination'] = None
    emit('destination_updated', None, to=room_id)


@socketio.on('disconnect')
def on_disconnect():
    for room_id, room in list(rooms.items()):
        if request.sid in room['riders']:
            name = room['riders'][request.sid]['name']
            del room['riders'][request.sid]
            emit('rider_left', {'sid': request.sid, 'name': name}, to=room_id)
            if not room['riders']:
                del rooms[room_id]
            break


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)
