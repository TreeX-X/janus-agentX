import React, { memo, useMemo } from 'react'
import { Box, Text } from 'ink'
import { marked, type Token, type Tokens } from 'marked'
import { displayText } from '../tool-display.js'
import { LOGO_TONE } from '../logo.js'

function inline(tokens: Token[]): React.ReactNode {
  return tokens.map((token, index) => {
    const children = 'tokens' in token && token.tokens ? inline(token.tokens) : 'text' in token ? token.text : token.raw
    switch (token.type) {
      case 'strong': return <Text key={index} bold>{children}</Text>
      case 'em': return <Text key={index} italic>{children}</Text>
      case 'del': return <Text key={index} strikethrough>{children}</Text>
      case 'codespan': return <Text key={index} color="cyan">{token.text}</Text>
      case 'link': return <Text key={index} color="cyan" underline>{children}{token.href !== token.text ? ` (${token.href})` : ''}</Text>
      case 'br': return '\n'
      case 'image': return <Text key={index}>{token.text} ({token.href})</Text>
      default: return <Text key={index}>{children}</Text>
    }
  })
}

function blocks(tokens: Token[], width: number, muted: boolean): React.ReactNode {
  return tokens.map((token, index) => {
    const color = muted ? LOGO_TONE.dim : LOGO_TONE.lit
    switch (token.type) {
      case 'space': return null
      case 'checkbox': return null
      case 'heading': return <Text key={index} bold color={muted ? color : 'cyan'}>{inline(token.tokens ?? [])}</Text>
      case 'paragraph':
      case 'text': return <Text key={index} color={color} wrap="wrap">{'tokens' in token && token.tokens ? inline(token.tokens) : token.text}</Text>
      case 'code': {
        const code = token as Tokens.Code
        const lines = code.text.split('\n')
        const digits = String(lines.length).length
        return <Box key={index} flexDirection="column" marginY={1}>
          <Text color={LOGO_TONE.dim}>{`┌ ${code.lang?.split(/\s/)[0] || 'code'}`}</Text>
          {lines.map((line, row) => <Box key={row}>
            <Box width={digits + 3} flexShrink={0}><Text color={LOGO_TONE.dim}>{`${String(row + 1).padStart(digits)} │ `}</Text></Box>
            <Box width={Math.max(1, width - digits - 3)}><Text color={code.lang === 'diff' && line.startsWith('+') ? 'green' : code.lang === 'diff' && line.startsWith('-') ? 'red' : muted ? color : 'cyan'} wrap="wrap">{line || ' '}</Text></Box>
          </Box>)}
          <Text color={LOGO_TONE.dim}>└</Text>
        </Box>
      }
      case 'blockquote': return <Box key={index}>
        <Box width={2} flexShrink={0}><Text color={LOGO_TONE.dim}>│ </Text></Box>
        <Box flexDirection="column" width={Math.max(1, width - 2)}>{blocks(token.tokens ?? [], Math.max(1, width - 2), true)}</Box>
      </Box>
      case 'list': return <Box key={index} flexDirection="column">
        {token.items.map((item: Tokens.ListItem, row: number) => {
          const prefix = item.task ? (item.checked ? '[x] ' : '[ ] ') : token.ordered ? `${Number(token.start) + row}. ` : '• '
          return <Box key={row}>
            <Box width={prefix.length} flexShrink={0}><Text color={color}>{prefix}</Text></Box>
            <Box flexDirection="column" width={Math.max(1, width - prefix.length)}>{blocks(item.tokens, Math.max(1, width - prefix.length), muted)}</Box>
          </Box>
        })}
      </Box>
      case 'table': {
        const table = token as Tokens.Table
        const cellWidth = Math.max(1, Math.floor(width / table.header.length))
        // Narrow terminals use one field per row, preserving every cell's text.
        if (cellWidth < 12) return <Box key={index} flexDirection="column">
          {table.rows.map((row, r) => <Box key={r} flexDirection="column" marginBottom={1}>
            {row.map((cell, c) => <Text key={c} color={color}><Text bold>{table.header[c].text}: </Text>{inline(cell.tokens)}</Text>)}
          </Box>)}
        </Box>
        return <Box key={index} flexDirection="column" marginY={1}>
          {[table.header, ...table.rows].map((row, r) => <Box key={r}>
            {row.map((cell, c) => <Box key={c} width={cellWidth} paddingRight={1}><Text bold={r === 0} color={r === 0 ? 'cyan' : color}>{inline(cell.tokens)}</Text></Box>)}
          </Box>)}
        </Box>
      }
      case 'hr': return <Text key={index} color={LOGO_TONE.dim}>{'─'.repeat(Math.max(1, width))}</Text>
      default: return <Text key={index} color={color}>{token.raw}</Text>
    }
  })
}

/** Marked accepts open fences and partial paragraphs during streaming. */
export const Markdown = memo(function Markdown({ text, width, muted = false }: { text: string; width: number; muted?: boolean }) {
  const tokens = useMemo(() => marked.lexer(displayText(text), { gfm: true }), [text])
  return <Box flexDirection="column" width={Math.max(1, width)}>{blocks(tokens, width, muted)}</Box>
})
