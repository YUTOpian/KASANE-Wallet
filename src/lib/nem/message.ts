// NEM (NIS1) encrypted messages, in the format NanoWallet and the NEM mobile wallets read and write:
// payload = salt (32) + iv (16) + AES-256-CBC ciphertext (PKCS#7), key from the two accounts' keys and the salt.
// (The SDK's newer AES-GCM format is NOT understood by those wallets, so it is never written here;
// it is still tried when reading, so messages in either format can be opened.)
import { PrivateKey, PublicKey } from 'symbol-sdk';
import { KeyPair, MessageEncoder, models } from 'symbol-sdk/nem';

const SALT_BYTES = 32;
const IV_BYTES = 16;
const AES_BLOCK = 16;

/** A NIS1 message payload holds up to 1024 bytes. */
export const NEM_MAX_PAYLOAD_BYTES = 1024;

/** Size of the encrypted payload for `textBytes` bytes of text: salt + iv + the text padded up to the next 16 bytes. */
export function nemEncryptedPayloadLength(textBytes: number): number {
  return SALT_BYTES + IV_BYTES + (Math.floor(textBytes / AES_BLOCK) + 1) * AES_BLOCK;
}

/** Longest text (in UTF-8 bytes) whose encrypted payload still fits in 1024 bytes. */
export const NEM_MAX_ENCRYPTED_MESSAGE_BYTES = ((NEM_MAX_PAYLOAD_BYTES - SALT_BYTES - IV_BYTES) / AES_BLOCK - 1) * AES_BLOCK + (AES_BLOCK - 1);

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from((hex.match(/.{1,2}/g) ?? []).map((h) => parseInt(h, 16)));

/** Encrypts `text` for the recipient with the sender's private key. Returns the payload (type 2 message body). */
export function encryptNemMessage(senderPrivateKey: string, recipientPublicKey: string, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > NEM_MAX_ENCRYPTED_MESSAGE_BYTES) throw new Error('message_too_long');
  const encoder = new MessageEncoder(new KeyPair(new PrivateKey(senderPrivateKey)));
  return Uint8Array.from(encoder.encodeDeprecated(new PublicKey(recipientPublicKey), bytes).message);
}

/**
 * Decrypts an encrypted payload (hex, as the node returns it). `otherPublicKey` is the other side's public
 * key: the sender's for a message we received, the recipient's for one we sent. null = cannot be decrypted.
 */
export function decryptNemMessage(myPrivateKey: string, otherPublicKey: string, payloadHex: string): string | null {
  try {
    const message = new models.Message();
    message.messageType = models.MessageType.ENCRYPTED;
    message.message = hexToBytes(payloadHex);
    const encoder = new MessageEncoder(new KeyPair(new PrivateKey(myPrivateKey)));
    const result = encoder.tryDecode(new PublicKey(otherPublicKey), message) as unknown as { isDecoded: boolean; message: Uint8Array | unknown };
    if (!result.isDecoded) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(result.message as Uint8Array);
  } catch {
    return null;
  }
}

/**
 * Same as encryptNemMessage, for raw bytes (the console encrypts whatever bytes the code hands over).
 * The payload is in the format NEM wallets read (see the top of this file).
 */
export function encryptNemBytes(senderPrivateKey: string, recipientPublicKey: string, data: Uint8Array): Uint8Array {
  if (data.length > NEM_MAX_ENCRYPTED_MESSAGE_BYTES) throw new Error('message_too_long');
  const encoder = new MessageEncoder(new KeyPair(new PrivateKey(senderPrivateKey)));
  return Uint8Array.from(encoder.encodeDeprecated(new PublicKey(recipientPublicKey), data).message);
}

/** Same as decryptNemMessage, for raw bytes in and out. null = cannot be decrypted. */
export function decryptNemBytes(myPrivateKey: string, otherPublicKey: string, payload: Uint8Array): Uint8Array | null {
  try {
    const message = new models.Message();
    message.messageType = models.MessageType.ENCRYPTED;
    message.message = Uint8Array.from(payload);
    const encoder = new MessageEncoder(new KeyPair(new PrivateKey(myPrivateKey)));
    const result = encoder.tryDecode(new PublicKey(otherPublicKey), message) as unknown as { isDecoded: boolean; message: Uint8Array | unknown };
    return result.isDecoded && result.message instanceof Uint8Array ? Uint8Array.from(result.message) : null;
  } catch {
    return null;
  }
}
