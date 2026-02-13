import { execSync } from 'child_process'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const STORIES_DIR = join(process.cwd(), 'docs', 'user-stories')
const PROMPT_FILE = join(process.cwd(), 'scripts', 'ralph', 'prompt.md')
const MAX_LOOPS = 5

async function getFailingStories(): Promise<string[]> {
  const files = await readdir(STORIES_DIR)
  const failing: string[] = []

  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const content = await readFile(join(STORIES_DIR, file), 'utf-8')
    const story = JSON.parse(content)
    if (!story.passes) failing.push(file)
  }

  return failing
}

async function runLoop() {
  console.log('🔄 Ralph Agent Loop starting...\n')

  for (let i = 1; i <= MAX_LOOPS; i++) {
    const failing = await getFailingStories()

    if (failing.length === 0) {
      console.log('🎉 All user stories pass! Loop complete.')
      return
    }

    console.log(`\n--- Loop ${i}/${MAX_LOOPS} ---`)
    console.log(`Failing stories: ${failing.join(', ')}`)

    const storyContents = await Promise.all(
      failing.map(async (f) => {
        const content = await readFile(join(STORIES_DIR, f), 'utf-8')
        return `### ${f}\n\`\`\`json\n${content}\n\`\`\``
      })
    )

    const prompt = [
      await readFile(PROMPT_FILE, 'utf-8'),
      '\n## 当前需要修复的 User Stories\n',
      storyContents.join('\n\n'),
      '\n请分析这些 user stories，编写测试验证它们，如果测试失败则修复代码，最后更新 passes 状态。',
    ].join('\n')

    console.log(`\nInvoking Claude Code agent...`)

    try {
      execSync(`echo '${prompt.replace(/'/g, "'\\''")}' | claude --dangerously-skip-permissions`, {
        stdio: 'inherit',
        cwd: process.cwd(),
        timeout: 600_000,
      })
    } catch (err) {
      console.error(`Loop ${i} agent exited with error:`, (err as Error).message)
    }
  }

  const remaining = await getFailingStories()
  if (remaining.length > 0) {
    console.log(`\n⚠️  Max loops reached. Still failing: ${remaining.join(', ')}`)
    process.exit(1)
  }
}

runLoop().catch((err) => {
  console.error('Runner error:', err)
  process.exit(1)
})
