import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

interface UserStory {
  id: string
  title: string
  passes: boolean
  priority: string
  tags: string[]
}

const STORIES_DIR = join(process.cwd(), 'docs', 'user-stories')

async function main() {
  const files = await readdir(STORIES_DIR)
  const jsonFiles = files.filter((f) => f.endsWith('.json'))

  if (jsonFiles.length === 0) {
    console.log('No user stories found.')
    process.exit(0)
  }

  let allPass = true
  const results: { file: string; story: UserStory; status: string }[] = []

  for (const file of jsonFiles) {
    const content = await readFile(join(STORIES_DIR, file), 'utf-8')
    const story: UserStory = JSON.parse(content)
    const status = story.passes ? 'PASS' : 'FAIL'
    if (!story.passes) allPass = false
    results.push({ file, story, status })
  }

  console.log('\n=== User Stories Status ===\n')
  for (const { file, story, status } of results) {
    const icon = status === 'PASS' ? '✅' : '❌'
    console.log(`${icon} [${status}] ${story.id}: ${story.title}`)
    console.log(`   File: ${file} | Priority: ${story.priority}`)
    console.log(`   Tags: ${story.tags.join(', ')}`)
    console.log()
  }

  const passCount = results.filter((r) => r.status === 'PASS').length
  console.log(`\nTotal: ${results.length} | Pass: ${passCount} | Fail: ${results.length - passCount}`)

  if (!allPass) {
    console.log('\n⚠️  Some user stories have not passed yet.')
    process.exit(1)
  }

  console.log('\n🎉 All user stories passed!')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
