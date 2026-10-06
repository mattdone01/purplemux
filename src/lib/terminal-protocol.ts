export const MSG_STDIN = 0x00;
export const MSG_STDOUT = 0x01;
export const MSG_RESIZE = 0x02;
export const MSG_HEARTBEAT = 0x03;
export const MSG_KILL_SESSION = 0x04;
export const MSG_WEB_STDIN = 0x05;
export const MSG_INPUT_ERROR = 0x06;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const encodeInputError = (message: string): Uint8Array => {
  const payload = encoder.encode(message);
  return new Uint8Array([MSG_INPUT_ERROR, ...payload]);
};

export const encodeStdout = (data: string): Uint8Array => {
  const payload = encoder.encode(data);
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = MSG_STDOUT;
  frame.set(payload, 1);
  return frame;
};

export const encodeStdin = (data: string): ArrayBuffer => {
  const payload = encoder.encode(data);
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = MSG_STDIN;
  frame.set(payload, 1);
  return frame.buffer;
};

export const encodeWebStdin = (data: string): ArrayBuffer => {
  const payload = encoder.encode(data);
  const frame = new Uint8Array(1 + payload.length);
  frame[0] = MSG_WEB_STDIN;
  frame.set(payload, 1);
  return frame.buffer;
};

export const encodeResize = (cols: number, rows: number): ArrayBuffer => {
  const frame = new ArrayBuffer(5);
  const view = new DataView(frame);
  view.setUint8(0, MSG_RESIZE);
  view.setUint16(1, cols);
  view.setUint16(3, rows);
  return frame;
};

export const encodeHeartbeat = (): ArrayBuffer => {
  return new Uint8Array([MSG_HEARTBEAT]).buffer;
};

export const encodeKillSession = (): ArrayBuffer => {
  return new Uint8Array([MSG_KILL_SESSION]).buffer;
};

export const decodeMessage = (
  data: ArrayBuffer,
): { type: number; payload: Uint8Array } => {
  const bytes = new Uint8Array(data);
  return {
    type: bytes[0],
    payload: bytes.slice(1),
  };
};

export { encoder as textEncoder, decoder as textDecoder };
