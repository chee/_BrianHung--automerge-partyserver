import { cbor } from 'https://esm.sh/@automerge/automerge-repo@2.0.0-alpha.1/slim?bundle-deps';
import { PartySocket } from 'https://esm.sh/partysocket';

import EventEmitter from 'https://esm.sh/eventemitter3';

export const isPeerMessage = message => message.type === 'peer';

export const isErrorMessage = message => message.type === 'error';

const toArrayBuffer = bytes => {
	const { buffer, byteOffset, byteLength } = bytes;
	return buffer.slice(byteOffset, byteOffset + byteLength);
};

function assert(value, message = 'Assertion failed') {
	if (value === false || value === null || value === undefined) {
		const error = new Error(trimLines(message));
		error.stack = removeLine(error.stack, 'assert.ts');
		throw error;
	}
}
const trimLines = s =>
	s
		.split('\n')
		.map(s => s.trim())
		.join('\n');
const removeLine = (s = '', targetText) =>
	s
		.split('\n')
		.filter(line => !line.includes(targetText))
		.join('\n');

export class PartyClientAdapter extends EventEmitter {
	#ready;
	#readyResolver;
	#readyPromise;
	isReady() {
		return this.#ready;
	}
	whenReady() {
		return this.#readyPromise;
	}
	#forceReady() {
		if (!this.#ready) {
			this.#ready = true;
			this.#readyResolver?.();
		}
	}
	#retryIntervalId;
	#log = console.debug;
	constructor(opts) {
		super();
		this.opts = opts;

		this.#ready = false;
		this.#readyPromise = new Promise(resolve => {
			this.#readyResolver = resolve;
		});

		this.onOpen = () => {
			this.#log('open');
			clearInterval(this.#retryIntervalId);
			this.#retryIntervalId = undefined;
			this.join();
		};
		// When a socket closes, or disconnects, remove it from the array.
		this.onClose = () => {
			this.#log('close');
			if (this.remotePeerId)
				this.emit('peer-disconnected', { peerId: this.remotePeerId });
		};
		this.onMessage = event => {
			this.receiveMessage(event.data);
		};
		/** The websocket error handler signature is different on node and the browser.  */
		this.onError = (
			event // node
		) => {
			if ('error' in event) {
				// (node)
				if (event.error.code !== 'ECONNREFUSED') {
					/* c8 ignore next */
					throw event.error;
				}
			} else {
				// (browser) We get no information about errors. https://stackoverflow.com/a/31003057/239663
				// There will be an error logged in the console (`WebSocket connection to 'wss://foo.com/'
				// failed`), but by design the error is unavailable to scripts. We'll just assume this is a
				// failed connection.
			}
			this.#log('Connection failed, retrying...');
		};
	}
	connect(peerId, peerMetadata) {
		if (!this.socket || !this.peerId) {
			// first time connecting
			this.#log('connecting');
			this.peerId = peerId;
			this.peerMetadata = peerMetadata ?? {};
		} else {
			this.#log('reconnecting');
			assert(peerId === this.peerId);
			// Remove the old event listeners before creating a new connection.
			this.socket.removeEventListener('open', this.onOpen);
			this.socket.removeEventListener('close', this.onClose);
			this.socket.removeEventListener('message', this.onMessage);
			this.socket.removeEventListener('error', this.onError);
		}
		// Wire up retries
		console.log(this.opts);
		this.socket = new PartySocket(this.opts);
		this.socket.binaryType = 'arraybuffer';
		this.socket.addEventListener('open', this.onOpen);
		this.socket.addEventListener('close', this.onClose);
		this.socket.addEventListener('message', this.onMessage);
		this.socket.addEventListener('error', this.onError);
		// Mark this adapter as ready if we haven't received an ack in 1 second.
		// We might hear back from the other end at some point but we shouldn't
		// hold up marking things as unavailable for any longer
		setTimeout(() => this.#forceReady(), 1000);
		this.join();
	}
	join() {
		assert(this.peerId);
		assert(this.socket);
		if (this.socket.readyState === WebSocket.OPEN) {
			this.send(joinMessage(this.peerId, this.peerMetadata));
		} else {
			// We'll try again in the `onOpen` handler
		}
	}
	disconnect() {
		assert(this.peerId);
		assert(this.socket);
		const socket = this.socket;
		if (socket) {
			socket.removeEventListener('open', this.onOpen);
			socket.removeEventListener('close', this.onClose);
			socket.removeEventListener('message', this.onMessage);
			socket.removeEventListener('error', this.onError);
			socket.close();
		}
		clearInterval(this.#retryIntervalId);
		if (this.remotePeerId)
			this.emit('peer-disconnected', { peerId: this.remotePeerId });
		this.socket = undefined;
	}
	send(message) {
		if ('data' in message && message.data?.byteLength === 0)
			throw new Error('Tried to send a zero-length message');
		assert(this.peerId);
		if (!this.socket) {
			this.#log('Tried to send on a disconnected socket.');
			return;
		}
		if (this.socket.readyState !== WebSocket.OPEN)
			throw new Error(`Websocket not ready (${this.socket.readyState})`);
		const encoded = cbor.encode(message);
		this.socket.send(toArrayBuffer(encoded));
	}
	peerCandidate(remotePeerId, peerMetadata) {
		assert(this.socket);
		this.#forceReady();
		this.remotePeerId = remotePeerId;
		this.emit('peer-candidate', {
			peerId: remotePeerId,
			peerMetadata,
		});
	}
	receiveMessage(messageBytes) {
		const message = cbor.decode(new Uint8Array(messageBytes));
		assert(this.socket);
		if (messageBytes.byteLength === 0)
			throw new Error('received a zero-length message');
		if (isPeerMessage(message)) {
			const { peerMetadata } = message;
			this.#log(`peer: ${message.senderId}`);
			this.peerCandidate(message.senderId, peerMetadata);
		} else if (isErrorMessage(message)) {
			this.#log(`error: ${message.message}`);
		} else {
			this.emit('message', message);
		}
	}
}
function joinMessage(senderId, peerMetadata) {
	return {
		type: 'join',
		senderId,
		peerMetadata,
		supportedProtocolVersions: ['1'],
	};
}
