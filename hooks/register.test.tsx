import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAEElEQVR4nGP4z8AARwzIHABvqgf5gNwAKAAAAABJRU5ErkJggg=='

const message = (text: string, surface: 'terminal' | 'desktop' = 'terminal') =>
  ({
    plugin: 'latex-math',
    component: 'AssistantMessage',
    requestId: 'msg_1',
    surface,
    props: { text, isFirstOfReply: true },
  }) as const

const engine = (on: On) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

const latex = (on: On, exitCode = 0) => {
  const calls: string[] = []
  on('process.run', (_$, e) => {
    calls.push(e.init?.stdin ?? '')
    return {
      value: {
        exitCode,
        stdout: exitCode === 0 ? TINY_PNG : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return calls
}

test('draws a display formula as an image under the leading text', async ($, on) => {
  engine(on)
  const calls = latex(on)
  const ui = await $.ui.mount(message('The area:\n\n$$\\int_0^1 x\\,dx$$\n\nDone.'))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(calls[0]).toContain('\\int_0^1 x\\,dx')
  await ui.unmount()
})

test('draws the bracket form too', async ($, on) => {
  engine(on)
  latex(on)
  const ui = await $.ui.mount(message('\\[ a^2 + b^2 = c^2 \\]'))

  expect(await ui.find({ type: 'Image' })).toBeTruthy()
  await ui.unmount()
})

test('leaves text without display math, inline math and code to the engine', async ($, on) => {
  engine(on)
  const calls = latex(on)
  const cases = ['Plain reply.', 'Inline $E = mc^2$ stays text.', '```\n$$ not math $$\n```', 'Wrap it as `$$...$$` please.']

  for (const text of cases) {
    const ui = await $.ui.mount(message(text))
    expect(await ui.find({ type: 'Image' })).toBeFalsy()
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }
  expect(calls.length).toBe(0)
})

test('falls back to the text when LaTeX fails', async ($, on) => {
  engine(on)
  latex(on, 1)
  const ui = await $.ui.mount(message('$$\\frac{1}{$$'))

  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

test('leaves every other surface to the engine', async ($, on) => {
  engine(on)
  const calls = latex(on)
  const ui = await $.ui.mount(message('$$x^2$$', 'desktop'))

  expect(await ui.find({ type: 'Image' })).toBeFalsy()
  expect(calls.length).toBe(0)
  await ui.unmount()
})
