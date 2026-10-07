// Note: host tools share schema validation and model exposure — see .agents/notes/harness/storage/history/workflowx-runtime.md
import { z } from 'zod'

/** JSON Schema subset used by built-in, host and MCP tools. Unsupported constraints fail explicitly. */
export interface ToolJsonSchema {
  type?: string | string[]
  properties?: Record<string, ToolJsonSchema>
  required?: string[]
  additionalProperties?: boolean | ToolJsonSchema
  items?: ToolJsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: ToolJsonSchema[]
  oneOf?: ToolJsonSchema[]
  description?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
}

export function toolSchemaToZod(schema: ToolJsonSchema, depth = 0): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 32) throw new Error('Invalid tool schema')
  const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', '$schema', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'])
  for (const key of Object.keys(schema)) {
    if (!supported.has(key)) throw new Error(`Unsupported tool schema constraint: ${key}`)
  }
  if (schema.anyOf && Object.keys(schema).some(key => !['anyOf', 'description', 'title', '$schema'].includes(key))) throw new Error('Unsupported constraints beside tool schema union')
  const next = (value: ToolJsonSchema) => toolSchemaToZod(value, depth + 1)
  let value: z.ZodTypeAny
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) {
    if (!Array.isArray(variants) || !variants.length) throw new Error('Empty tool schema union')
    const choices = variants.map(next)
    value = choices.length === 1 ? choices[0] : z.union([choices[0], choices[1], ...choices.slice(2)])
    if (schema.oneOf) value = value.refine(input => choices.filter(choice => choice.safeParse(input).success).length === 1)
  } else if (Array.isArray(schema.type)) {
    if (!schema.type.length) throw new Error('Empty tool schema type')
    const choices = schema.type.map(type => next({ ...schema, type }))
    value = choices.length === 1 ? choices[0] : z.union([choices[0], choices[1], ...choices.slice(2)])
  } else {
    switch (schema.type) {
      case 'string': {
        let field = z.string()
        if (schema.minLength !== undefined) field = field.min(schema.minLength)
        if (schema.maxLength !== undefined) field = field.max(schema.maxLength)
        if (schema.pattern !== undefined) field = field.regex(new RegExp(schema.pattern))
        value = field; break
      }
      case 'number': case 'integer': {
        let field = schema.type === 'integer' ? z.number().int() : z.number().finite()
        if (schema.minimum !== undefined) field = field.min(schema.minimum)
        if (schema.maximum !== undefined) field = field.max(schema.maximum)
        value = field; break
      }
      case 'boolean': value = z.boolean(); break
      case 'null': value = z.null(); break
      case 'array': {
        let field = z.array(schema.items ? next(schema.items) : z.unknown())
        if (schema.minItems !== undefined) field = field.min(schema.minItems)
        if (schema.maxItems !== undefined) field = field.max(schema.maxItems)
        value = field; break
      }
      case 'object': {
        const properties = schema.properties ?? {}
        if (typeof properties !== 'object' || Array.isArray(properties)) throw new Error('Invalid tool schema properties')
        const required = schema.required ?? []
        if (!Array.isArray(required) || new Set(required).size !== required.length || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))) throw new Error('Invalid required tool fields')
        const fields = Object.fromEntries(Object.entries(properties).map(([key, definition]) => {
          const field = next(definition)
          return [key, required.includes(key) ? field : field.optional()]
        }))
        const object = z.object(fields)
        value = schema.additionalProperties === false ? object.strict()
          : typeof schema.additionalProperties === 'object' ? object.catchall(next(schema.additionalProperties)) : object.passthrough()
        break
      }
      case undefined: value = z.unknown(); break
      default: throw new Error(`Unsupported tool schema type: ${schema.type}`)
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length) throw new Error('Invalid tool enum')
    const choices = schema.enum.map(item => {
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new Error('Unsupported complex tool enum')
      return z.literal(item as string | number | boolean | null)
    }).filter(choice => value.safeParse(choice.value).success)
    if (!choices.length) throw new Error('Tool enum conflicts with its type')
    value = choices.length === 1 ? choices[0] : z.union([choices[0], choices[1], ...choices.slice(2)])
  }
  if (Object.hasOwn(schema, 'const')) {
    if (schema.const !== null && !['string', 'number', 'boolean'].includes(typeof schema.const)) throw new Error('Unsupported complex tool const')
    if (!value.safeParse(schema.const).success) throw new Error('Tool const conflicts with its type')
    value = z.literal(schema.const as string | number | boolean | null)
  }
  return schema.description ? value.describe(schema.description) : value
}
