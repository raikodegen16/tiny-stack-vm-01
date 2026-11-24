import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const STACK_MAX = 256, CALLS_MAX = 64, MEMORY_WORDS = 256;
const STEP_LIMIT = 1e6, OUTPUT_MAX = 65536;
const SPEC =
  "00:000,01:101,02:401,03:010,04:012,05:022,06:023,07:033," +
  "10:021,11:021,12:021,13:021,14:021,15:021,16:021,17:011," +
  "18:021,19:021,1a:021,1b:011,1c:021,1d:021,1e:021,20:021," +
  "21:021,22:021,30:200,31:210,32:210,33:200,34:000,40:011," +
  "41:020,50:010,51:010,52:001,53:010";
const OPS = new Map<number, [number, number, number]>();
for (const e of SPEC.split(",")) {
  const [h, t] = e.split(":");
  OPS.set(parseInt(h, 16), [+t[0], +t[1], +t[2]]);
}
const enc = new TextEncoder();
function run(program: Buffer, input: Buffer): { stdout: Uint8Array; exit: number } {
  const n = program.length;
  const D = new Int32Array(STACK_MAX);
  let sp = 0;
  const C = new Int32Array(CALLS_MAX);
  let csp = 0;
  const M = new Int32Array(MEMORY_WORDS);
  const out = new Uint8Array(OUTPUT_MAX);
  let olen = 0;
  let inPos = 0;
  let pc = 0;
  let steps = 0;
  const done = (exit: number) => ({ stdout: out.slice(0, olen), exit });
  for (;;) {
    if (steps === STEP_LIMIT) return done(10);
    if (pc < 0 || pc >= n) return done(9);
    const op = program[pc];
    const spec = OPS.get(op);
    if (spec === undefined) return done(5);
    const imm = spec[0];
    const pops = spec[1];
    const pushes = spec[2];
    if (pc + imm >= n) return done(9);
    steps++;
    const next = pc + 1 + imm;
    if (sp < pops) return done(2);
    if (sp - pops + pushes > STACK_MAX) return done(3);
    pc = next;
    switch (op) {
      case 0x00:
        return done(0);
      case 0x01:
        D[sp++] = (program[next - 1] << 24) >> 24;
        break;
      case 0x02:
        D[sp++] =
          program[next - 4] |
          (program[next - 3] << 8) |
          (program[next - 2] << 16) |
          (program[next - 1] << 24);
        break;
      case 0x03:
        sp--;
        break;
      case 0x04:
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: {
        const t = D[sp - 1];
        D[sp - 1] = D[sp - 2];
        D[sp - 2] = t;
        break;
      }
      case 0x06:
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: {
        const a = D[sp - 3];
        D[sp - 3] = D[sp - 2];
        D[sp - 2] = D[sp - 1];
        D[sp - 1] = a;
        break;
      }
      case 0x17:
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b:
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x10:
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x18:
      case 0x19:
      case 0x1a:
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x20:
      case 0x21:
      case 0x22: {
        const b = D[sp - 1];
        const a = D[sp - 2];
        let r: number;
        switch (op) {
          case 0x10:
            r = (a + b) | 0;
            break;
          case 0x11:
            r = (a - b) | 0;
            break;
          case 0x12:
            r = Math.imul(a, b);
            break;
          case 0x13:
            if (b === 0) return done(4);
            r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
            break;
          case 0x14:
            if (b === 0) return done(4);
            r = b === -1 ? 0 : (a % b) | 0;
            break;
          case 0x15:
            if (b === 0) return done(4);
            r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
            break;
          case 0x16:
            if (b === 0) return done(4);
            r = ((a >>> 0) % (b >>> 0)) | 0;
            break;
          case 0x18:
            r = a & b;
            break;
          case 0x19:
            r = a | b;
            break;
          case 0x1a:
            r = a ^ b;
            break;
          case 0x1c:
            r = a << (b & 31);
            break;
          case 0x1d:
            r = a >> (b & 31);
            break;
          case 0x1e:
            r = (a >>> (b & 31)) | 0;
            break;
          case 0x20:
            r = a === b ? 1 : 0;
            break;
          case 0x21:
            r = a < b ? 1 : 0;
            break;
          default:
            r = a >>> 0 < b >>> 0 ? 1 : 0;
            break;
        }
        sp -= 2;
        D[sp++] = r;
        break;
      }
      case 0x30:
      case 0x31:
      case 0x32: {
        const rel = ((program[next - 2] | (program[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33:
        if (csp === CALLS_MAX) return done(7);
        C[csp++] = next;
        pc = program[next - 2] | (program[next - 1] << 8);
        break;
      case 0x34:
        if (csp === 0) return done(8);
        pc = C[--csp];
        break;
      case 0x40: {
        const addr = D[sp - 1];
        if (addr < 0 || addr >= MEMORY_WORDS) return done(6);
        D[sp - 1] = M[addr];
        break;
      }
      case 0x41: {
        const addr = D[sp - 1];
        const v = D[sp - 2];
        if (addr < 0 || addr >= MEMORY_WORDS) return done(6);
        sp -= 2;
        M[addr] = v;
        break;
      }
      case 0x50: {
        const bytes = enc.encode(String(D[sp - 1]));
        if (olen + bytes.length > OUTPUT_MAX) return done(11);
        sp--;
        out.set(bytes, olen);
        olen += bytes.length;
        break;
      }
      case 0x51:
        if (olen + 1 > OUTPUT_MAX) return done(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52:
        D[sp++] = inPos < input.length ? input[inPos++] : -1;
        break;
      case 0x53:
        return done(D[--sp] & 255);
    }
  }
}
const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
const ids = readdirSync(inputDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const id of ids) {
  const dir = join(inputDir, id);
  let program: Buffer;
  try {
    program = readFileSync(join(dir, "program.bin"));
  } catch {
    program = Buffer.alloc(0);
  }
  let input: Buffer;
  try {
    input = readFileSync(join(dir, "input.bin"));
  } catch {
    input = Buffer.alloc(0);
  }
  const result = run(program, input);
  const outDir = join(outputDir, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "stdout.bin"), result.stdout);
  writeFileSync(join(outDir, "exit.txt"), `${result.exit}\n`);
}
