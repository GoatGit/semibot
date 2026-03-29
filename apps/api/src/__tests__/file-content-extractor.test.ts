import fs from 'fs-extra'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import { extractFileContent } from '../utils/file-content-extractor'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-file-extractor-'))
  tempDirs.push(dir)
  return dir
}

async function buildFakePptx(filePath: string): Promise<void> {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>', 'utf8'))
  zip.addFile(
    'ppt/slides/slide1.xml',
    Buffer.from(
      `<p:sld>
        <p:cSld>
          <p:spTree>
            <p:sp>
              <p:txBody>
                <a:p><a:r><a:t>季度汇报</a:t></a:r></a:p>
                <a:p><a:r><a:t>收入增长 25%</a:t></a:r></a:p>
              </p:txBody>
            </p:sp>
          </p:spTree>
        </p:cSld>
      </p:sld>`,
      'utf8'
    )
  )
  zip.writeZip(filePath)
}

describe('extractFileContent(pptx)', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)))
  })

  it('extracts readable text from pptx slides', async () => {
    const dir = await makeTempDir()
    const filePath = path.join(dir, 'report.pptx')
    await buildFakePptx(filePath)

    const extracted = await extractFileContent(
      filePath,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'report.pptx'
    )

    expect(extracted.isImage).toBe(false)
    expect(extracted.text).toContain('Slide 1')
    expect(extracted.text).toContain('季度汇报')
    expect(extracted.text).toContain('收入增长 25%')
  })
})

