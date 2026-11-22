import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promptHidden } from '../../scripts/set-pos-password.js';

/**
 * The hidden password prompt.
 *
 * These exist because the first version wrote the question to stdout and then
 * created a readline interface with `terminal: true`, which redrew the line
 * from its own (empty) prompt and wiped the question. The user saw a blank
 * terminal with no sign that anything was waiting for input — the script
 * looked hung. Nothing caught it, because the interactive path had never been
 * exercised: piped input takes a different branch entirely.
 */

/** A stand-in for a terminal, so the interactive path can be driven. */
function fakeTty() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = (on) => { input.rawMode = on; };
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  input.off = input.removeListener.bind(input);

  const written = [];
  const output = { write: (text) => { written.push(text); return true; } };

  return { input, output, written, text: () => written.join('') };
}

describe('password prompt: the question is actually shown', () => {
  test('writes the question before any input arrives', async () => {
    const tty = fakeTty();
    const pending = promptHidden('New password: ', tty);
    // Before a single keystroke, the user must be able to see what is wanted.
    assert.match(tty.text(), /New password: /);
    tty.input.emit('data', 'secret\r');
    await pending;
  });

  test('returns what was typed', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', 'my-password-here\r');
    assert.equal(await pending, 'my-password-here');
  });

  test('never echoes the password', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', 'top-secret-value\r');
    await pending;
    assert.ok(!tty.text().includes('top-secret-value'),
      'the password must not appear in terminal output');
  });
});

describe('password prompt: key handling', () => {
  test('turns raw mode on, and back off when finished', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    assert.equal(tty.input.rawMode, true);
    tty.input.emit('data', 'abc\r');
    await pending;
    assert.equal(tty.input.rawMode, false, 'leaving raw mode on would break the shell');
  });

  test('accepts a password arriving in several chunks, as typing does', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    for (const char of 'typed-slowly') tty.input.emit('data', char);
    tty.input.emit('data', '\r');
    assert.equal(await pending, 'typed-slowly');
  });

  test('accepts a paste arriving as one chunk, newline included', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', 'pasted-password\n');
    assert.equal(await pending, 'pasted-password');
  });

  test('backspace removes the last character', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', 'passwordX');
    tty.input.emit('data', '\u007f');
    tty.input.emit('data', '\r');
    assert.equal(await pending, 'password');
  });

  test('backspace on an empty value does not go negative', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', '\u007f\u007f\u007f');
    tty.input.emit('data', 'abc\r');
    assert.equal(await pending, 'abc');
  });

  test('arrow keys and control characters are ignored, not inserted', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', '\u001b[A');  // up arrow
    tty.input.emit('data', 'real-password');
    tty.input.emit('data', '\u001b[D');  // left arrow
    tty.input.emit('data', '\r');
    const result = await pending;
    assert.equal(result, 'real-password', `escape sequences leaked in: ${JSON.stringify(result)}`);
  });

  test('both carriage return and newline end the prompt', async () => {
    for (const ending of ['\r', '\n']) {
      const tty = fakeTty();
      const pending = promptHidden('pw: ', tty);
      tty.input.emit('data', `done${ending}`);
      assert.equal(await pending, 'done');
    }
  });

  test('surrounding whitespace is trimmed', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', '  spaced-password  \r');
    assert.equal(await pending, 'spaced-password');
  });
});

describe('password prompt: escape sequences cannot corrupt a password', () => {
  const cases = [
    ['up arrow', '\u001b[A'],
    ['down arrow', '\u001b[B'],
    ['right arrow', '\u001b[C'],
    ['left arrow', '\u001b[D'],
    ['home', '\u001b[H'],
    ['end', '\u001b[F'],
    ['delete', '\u001b[3~'],
    ['page up', '\u001b[5~'],
    ['F1 (SS3)', '\u001bOP'],
  ];

  for (const [name, sequence] of cases) {
    test(`${name} inserts nothing`, async () => {
      const tty = fakeTty();
      const pending = promptHidden('pw: ', tty);
      tty.input.emit('data', sequence);
      tty.input.emit('data', 'clean-password');
      tty.input.emit('data', sequence);
      tty.input.emit('data', '\r');
      const result = await pending;
      assert.equal(result, 'clean-password',
        `${name} corrupted the password: ${JSON.stringify(result)}`);
    });
  }

  test('a sequence split across chunks is still swallowed', async () => {
    // Keystrokes do not always arrive whole.
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', '\u001b');
    tty.input.emit('data', '[');
    tty.input.emit('data', 'A');
    tty.input.emit('data', 'password-intact\r');
    assert.equal(await pending, 'password-intact');
  });

  test('a real bracket typed in a password is kept', async () => {
    const tty = fakeTty();
    const pending = promptHidden('pw: ', tty);
    tty.input.emit('data', 'pass[word]-ok\r');
    assert.equal(await pending, 'pass[word]-ok', 'only ESC-led sequences are dropped');
  });
});
