import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { countRoundsOai, groupIntoRoundsOai } from '../rounds.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('groupIntoRoundsOai', () => {
  it('groups user message as single-message round', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.startMessageIndex, 0)
    assert.strictEqual(rounds[0]!.endMessageIndex, 1)
    assert.strictEqual(rounds[0]!.hasToolCalls, false)
  })

  it('groups assistant message without tool_calls as single-message round', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: 'hi there' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.hasToolCalls, false)
  })

  it('groups assistant with tool_calls and matching tool results as one round', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.startMessageIndex, 0)
    assert.strictEqual(rounds[0]!.endMessageIndex, 2)
    assert.strictEqual(rounds[0]!.hasToolCalls, true)
    assert.strictEqual(rounds[0]!.hasToolResults, true)
    assert.strictEqual(rounds[0]!.apiInvariant, 'ok')
  })

  it('detects broken round with missing tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
      // tc_2 has no result
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.apiInvariant, 'broken')
  })

  it('detects orphan tool result as repaired round', () => {
    const messages: OaiMessage[] = [
      { role: 'tool', tool_call_id: 'tc_orphan', content: 'orphan result' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.apiInvariant, 'repaired')
    assert.strictEqual(rounds[0]!.hasToolResults, true)
  })

  it('handles complex conversation with multiple rounds', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Read file' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
      { role: 'assistant', content: 'Here is the file content' },
      { role: 'user', content: 'Write file' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_2', content: 'written' },
      { role: 'assistant', content: 'Done' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    // system: 1, user1: 1, asst+tool: 1, asst: 1, user2: 1, asst+tool: 1, asst: 1
    assert.ok(rounds.length >= 5)
  })

  it('increments turn number on user messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply2' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds[0]!.turnNumber, 1)
    assert.strictEqual(rounds[2]!.turnNumber, 2)
  })
})

/**
 * countRoundsOai exists because runResumePreflightOai used
 * `groupIntoRoundsOai(m).length` purely to fill the (never-read) roundCount
 * field — paying a per-message character-walk token estimate on every request
 * build (issue #139: ~21ms at 400 rounds, >99% of that pass). The counter must
 * be exactly equivalent to the round grouping, hence the parity assertions
 * against groupIntoRoundsOai below.
 */
describe('countRoundsOai', () => {
  function asstWithTools(id: string): OaiMessage {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    }
  }

  it('returns 0 for empty history', () => {
    assert.strictEqual(countRoundsOai([]), 0)
  })

  it('counts hand-derived rounds on a mixed conversation (independent spec)', () => {
    // Hand-derived: system→1, user→2, asst+tool→3, asst→4, user→5, asst+tool→6, asst→7
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read' },
      asstWithTools('tc_1'),
      { role: 'tool', tool_call_id: 'tc_1', content: 'body' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'write' },
      asstWithTools('tc_2'),
      { role: 'tool', tool_call_id: 'tc_2', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ]
    assert.strictEqual(countRoundsOai(messages), 7)
  })

  it('counts an orphan tool message as its own round', () => {
    assert.strictEqual(countRoundsOai([{ role: 'tool', tool_call_id: 'x', content: 'orphan' }]), 1)
  })

  it('does not merge consecutive assistant(tool_calls) without tool results', () => {
    assert.strictEqual(countRoundsOai([asstWithTools('a'), asstWithTools('b')]), 2)
  })

  it('counts a 100-round history at 3 rounds per round-trip (independent spec)', () => {
    // Per round-trip: user→1, assistant(tool_calls)+tool→1 (the tool message is
    // absorbed into the assistant's round, not counted), trailing assistant→1.
    const messages: OaiMessage[] = []
    for (let i = 0; i < 100; i++) {
      messages.push({ role: 'user', content: `u${i}` })
      messages.push(asstWithTools(`tc_${i}`))
      messages.push({ role: 'tool', tool_call_id: `tc_${i}`, content: `r${i}` })
      messages.push({ role: 'assistant', content: `a${i}` })
    }
    assert.strictEqual(countRoundsOai(messages), 300)
  })

  it('agrees with groupIntoRoundsOai().length on assorted shapes', () => {
    const samples: OaiMessage[][] = [
      [],
      [{ role: 'user', content: 'only user' }],
      [{ role: 'assistant', content: 'only assistant' }],
      [{ role: 'system', content: 'only system' }],
      [{ role: 'tool', tool_call_id: 'a', content: 'orphan' }, { role: 'tool', tool_call_id: 'b', content: 'orphan2' }],
      [asstWithTools('x'), asstWithTools('y')],
      [asstWithTools('x'), { role: 'tool', tool_call_id: 'x', content: 'r' }, { role: 'user', content: 'next' }],
      [asstWithTools('x'), { role: 'tool', tool_call_id: 'foreign', content: 'r' }],
      [asstWithTools('x'), { role: 'assistant', content: 'mid' }, { role: 'tool', tool_call_id: 'x', content: 'late' }],
      [
        { role: 'user', content: 'u' },
        asstWithTools('a'),
        { role: 'tool', tool_call_id: 'a', content: 'ra' },
        { role: 'tool', tool_call_id: 'b', content: 'rb' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'u2' },
      ],
    ]
    for (const [i, m] of samples.entries()) {
      assert.strictEqual(
        countRoundsOai(m),
        groupIntoRoundsOai(m).length,
        `sample ${i} mismatch: ${JSON.stringify(m).slice(0, 120)}`,
      )
    }
  })

  it('agrees with groupIntoRoundsOai().length on a 100-round history', () => {
    const messages: OaiMessage[] = []
    for (let i = 0; i < 100; i++) {
      messages.push({ role: 'user', content: `u${i}` })
      messages.push(asstWithTools(`tc_${i}`))
      messages.push({ role: 'tool', tool_call_id: `tc_${i}`, content: `r${i}` })
      messages.push({ role: 'assistant', content: `a${i}` })
    }
    assert.strictEqual(countRoundsOai(messages), groupIntoRoundsOai(messages).length)
  })
})
