import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Tiny stack virtual machine, written from the prose ISA spec only.

function run(program: Buffer, input: Buffer): { exit: number; out: Buffer } {
  const mem = new Int32Array(256);
  const st: number[] = [];
  const calls: number[] = [];
  const out: number[] = [];
  const len = program.length;
  let pc = 0;
  let steps = 0;
  let ip = 0;
  let exit = -1;

  const need = (n: number): boolean => {
    if (st.length < n) {
      exit = 2;
      return false;
    }
    return true;
  };
  const room = (n: number): boolean => {
    if (st.length + n > 256) {
      exit = 3;
      return false;
    }
    return true;
  };
  const bin = (f: (a: number, b: number) => number): void => {
    if (!need(2)) return;
    const b = st.pop() as number;
    const a = st.pop() as number;
    st.push(f(a, b));
  };
  const divPair = (): [number, number] | null => {
    if (!need(2)) return null;
    const b = st.pop() as number;
    const a = st.pop() as number;
    if (b === 0) {
      exit = 4;
      return null;
    }
    return [a, b];
  };

  while (exit < 0) {
    if (steps === 1000000) {
      exit = 10;
      break;
    }
    if (pc < 0 || pc >= len) {
      exit = 9;
      break;
    }
    const op = program[pc];
    const known =
      op <= 0x07 ||
      (op >= 0x10 && op <= 0x1e) ||
      (op >= 0x20 && op <= 0x22) ||
      (op >= 0x30 && op <= 0x34) ||
      op === 0x40 ||
      op === 0x41 ||
      (op >= 0x50 && op <= 0x53);
    if (!known) {
      exit = 5;
      break;
    }
    let imm = 0;
    if (op === 0x01) imm = 1;
    else if (op === 0x02) imm = 4;
    else if (op >= 0x30 && op <= 0x33) imm = 2;
    if (pc + imm >= len) {
      exit = 9;
      break;
    }
    steps += 1;
    const nextPc = pc + 1 + imm;
    let jumped = false;

    switch (op) {
      case 0x00:
        exit = 0;
        break;
      case 0x01: {
        if (!room(1)) break;
        const b = program[pc + 1];
        st.push(b < 128 ? b : b - 256);
        break;
      }
      case 0x02:
        if (!room(1)) break;
        st.push(program.readInt32LE(pc + 1));
        break;
      case 0x03:
        if (!need(1)) break;
        st.pop();
        break;
      case 0x04:
        if (!need(1) || !room(1)) break;
        st.push(st[st.length - 1]);
        break;
      case 0x05: {
        if (!need(2)) break;
        const t = st[st.length - 1];
        st[st.length - 1] = st[st.length - 2];
        st[st.length - 2] = t;
        break;
      }
      case 0x06:
        if (!need(2) || !room(1)) break;
        st.push(st[st.length - 2]);
        break;
      case 0x07: {
        if (!need(3)) break;
        const a = st[st.length - 3];
        st[st.length - 3] = st[st.length - 2];
        st[st.length - 2] = st[st.length - 1];
        st[st.length - 1] = a;
        break;
      }
      case 0x10:
        bin((a, b) => (a + b) | 0);
        break;
      case 0x11:
        bin((a, b) => (a - b) | 0);
        break;
      case 0x12:
        bin((a, b) => Math.imul(a, b));
        break;
      case 0x13: {
        const p = divPair();
        if (p !== null) st.push((p[0] / p[1]) | 0);
        break;
      }
      case 0x14: {
        const p = divPair();
        if (p !== null) st.push((p[0] % p[1]) | 0);
        break;
      }
      case 0x15: {
        const p = divPair();
        if (p !== null) st.push(Math.floor((p[0] >>> 0) / (p[1] >>> 0)) | 0);
        break;
      }
      case 0x16: {
        const p = divPair();
        if (p !== null) st.push(((p[0] >>> 0) % (p[1] >>> 0)) | 0);
        break;
      }
      case 0x17:
        if (!need(1)) break;
        st.push((-(st.pop() as number)) | 0);
        break;
      case 0x18:
        bin((a, b) => a & b);
        break;
      case 0x19:
        bin((a, b) => a | b);
        break;
      case 0x1a:
        bin((a, b) => a ^ b);
        break;
      case 0x1b:
        if (!need(1)) break;
        st.push(~(st.pop() as number));
        break;
      case 0x1c:
        bin((a, b) => a << (b & 31));
        break;
      case 0x1d:
        bin((a, b) => a >> (b & 31));
        break;
      case 0x1e:
        bin((a, b) => (a >>> (b & 31)) | 0);
        break;
      case 0x20:
        bin((a, b) => (a === b ? 1 : 0));
        break;
      case 0x21:
        bin((a, b) => (a < b ? 1 : 0));
        break;
      case 0x22:
        bin((a, b) => ((a >>> 0) < (b >>> 0) ? 1 : 0));
        break;
      case 0x30:
        pc = nextPc + program.readInt16LE(pc + 1);
        jumped = true;
        break;
      case 0x31: {
        if (!need(1)) break;
        const v = st.pop() as number;
        if (v === 0) {
          pc = nextPc + program.readInt16LE(pc + 1);
          jumped = true;
        }
        break;
      }
      case 0x32: {
        if (!need(1)) break;
        const v = st.pop() as number;
        if (v !== 0) {
          pc = nextPc + program.readInt16LE(pc + 1);
          jumped = true;
        }
        break;
      }
      case 0x33:
        if (calls.length >= 64) {
          exit = 7;
          break;
        }
        calls.push(nextPc);
        pc = program.readUInt16LE(pc + 1);
        jumped = true;
        break;
      case 0x34:
        if (calls.length === 0) {
          exit = 8;
          break;
        }
        pc = calls.pop() as number;
        jumped = true;
        break;
      case 0x40: {
        if (!need(1)) break;
        const addr = st.pop() as number;
        if (addr < 0 || addr > 255) {
          exit = 6;
          break;
        }
        st.push(mem[addr]);
        break;
      }
      case 0x41: {
        if (!need(2)) break;
        const addr = st.pop() as number;
        const v = st.pop() as number;
        if (addr < 0 || addr > 255) {
          exit = 6;
          break;
        }
        mem[addr] = v;
        break;
      }
      case 0x50: {
        if (!need(1)) break;
        const s = String(st.pop() as number);
        if (out.length + s.length > 65536) {
          exit = 11;
          break;
        }
        for (let i = 0; i < s.length; i += 1) out.push(s.charCodeAt(i));
        break;
      }
      case 0x51: {
        if (!need(1)) break;
        if (out.length + 1 > 65536) {
          exit = 11;
          break;
        }
        out.push((st.pop() as number) & 255);
        break;
      }
      case 0x52:
        if (!room(1)) break;
        st.push(ip < input.length ? input[ip++] : -1);
        break;
      case 0x53:
        if (!need(1)) break;
        exit = (st.pop() as number) & 255;
        break;
    }
    if (!jumped) pc = nextPc;
  }

  return { exit, out: Buffer.from(out) };
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

for (const id of readdirSync(inputDir).sort()) {
  const dir = join(inputDir, id);
  const program = readFileSync(join(dir, "program.bin"));
  let input: Buffer;
  try {
    input = readFileSync(join(dir, "input.bin"));
  } catch {
    input = Buffer.alloc(0);
  }
  const { exit, out } = run(program, input);
  const outDir = join(outputDir, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "stdout.bin"), out);
  writeFileSync(join(outDir, "exit.txt"), `${exit}\n`);
}
