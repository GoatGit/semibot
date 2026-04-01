import { getLocalDb } from './db-local'

type SqlFragment = {
  __sqlFragment: true
  text: string
  values: unknown[]
}

function isTemplateStringsArray(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'raw')
}

function isSqlFragment(value: unknown): value is SqlFragment {
  return Boolean(value && typeof value === 'object' && (value as SqlFragment).__sqlFragment === true)
}

function buildFragment(strings: TemplateStringsArray, values: unknown[]): SqlFragment {
  let text = ''
  const bindings: unknown[] = []
  for (let i = 0; i < strings.length; i += 1) {
    text += strings[i]
    if (i >= values.length) {
      continue
    }
    const value = values[i]
    if (isSqlFragment(value)) {
      text += value.text
      bindings.push(...value.values)
      continue
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        text += '(NULL)'
      } else {
        text += `(${value.map(() => '?').join(', ')})`
        bindings.push(...value)
      }
      continue
    }
    text += '?'
    bindings.push(value)
  }
  return { __sqlFragment: true, text, values: bindings }
}

function execute(fragment: SqlFragment): unknown {
  const query = fragment.text.trim()
  if (!query) {
    return []
  }
  if (/information_schema\./i.test(query)) {
    return []
  }
  const db = getLocalDb()
  const stmt = db.prepare(query)
  if (/^\s*(select|pragma|with)\b/i.test(query) || /\breturning\b/i.test(query)) {
    return stmt.all(...fragment.values)
  }
  return stmt.run(...fragment.values)
}

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>
  (identifier: string): SqlFragment
  json: (value: unknown) => string
}

export const sql = ((first: TemplateStringsArray | string, ...values: unknown[]) => {
  if (typeof first === 'string') {
    return { __sqlFragment: true, text: first, values: [] }
  }
  if (isTemplateStringsArray(first)) {
    return Promise.resolve(execute(buildFragment(first, values)))
  }
  throw new TypeError('Unsupported sql invocation')
}) as SqlTag

sql.json = (value: unknown) => JSON.stringify(value)
