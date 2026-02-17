import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger.js';
import { config } from './config.js';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  size: number;
  tempPath?: string;
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = ImageContentBlock | TextContentBlock;

export class FileHandler {
  private logger = new Logger('FileHandler');

  async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
    const processedFiles: ProcessedFile[] = [];

    for (const file of files) {
      try {
        const processed = await this.downloadFile(file);
        if (processed) {
          processedFiles.push(processed);
        }
      } catch (error) {
        this.logger.error(`Failed to process file ${file.name}`, error);
      }
    }

    return processedFiles;
  }

  private async downloadFile(file: any): Promise<ProcessedFile | null> {
    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      return null;
    }

    try {
      const downloadUrl = file.url_private_download || file.url_private;
      this.logger.debug('Downloading file', {
        name: file.name,
        mimetype: file.mimetype,
        url: downloadUrl ? downloadUrl.substring(0, 80) + '...' : 'MISSING',
        hasDownloadUrl: !!file.url_private_download,
        hasPrivateUrl: !!file.url_private,
      });

      if (!downloadUrl) {
        throw new Error('No download URL available for file');
      }

      const response = await fetch(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${config.slack.botToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const buffer = Buffer.from(await response.arrayBuffer());

      this.logger.info('File downloaded', {
        name: file.name,
        responseContentType: contentType,
        bufferSize: buffer.length,
        firstBytes: buffer.subarray(0, 8).toString('hex'),
      });

      // Validate image files have correct magic bytes
      if (this.isImageFile(file.mimetype) && !this.hasValidImageHeader(buffer)) {
        this.logger.error('Downloaded file does not have valid image header', {
          name: file.name,
          expectedMimetype: file.mimetype,
          responseContentType: contentType,
          firstBytes: buffer.subarray(0, 16).toString('hex'),
          firstChars: buffer.subarray(0, 100).toString('utf-8').substring(0, 100),
        });
        throw new Error(`Downloaded file is not a valid image (got content-type: ${contentType})`);
      }

      const tempDir = os.tmpdir();
      const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${file.name}`);
      
      fs.writeFileSync(tempPath, buffer);

      const processed: ProcessedFile = {
        path: tempPath,
        name: file.name,
        mimetype: file.mimetype,
        isImage: this.isImageFile(file.mimetype),
        isText: this.isTextFile(file.mimetype),
        size: file.size,
        tempPath,
      };

      this.logger.info('File downloaded successfully', {
        name: file.name,
        tempPath,
        isImage: processed.isImage,
        isText: processed.isText,
      });

      return processed;
    } catch (error) {
      this.logger.error('Failed to download file', error);
      return null;
    }
  }

  private hasValidImageHeader(buffer: Buffer): boolean {
    if (buffer.length < 4) return false;

    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true;
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return true;

    return false;
  }

  private isImageFile(mimetype: string): boolean {
    return mimetype.startsWith('image/');
  }

  private isTextFile(mimetype: string): boolean {
    const textTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
    ];

    return textTypes.some(type => mimetype.startsWith(type));
  }

  buildContentBlocks(files: ProcessedFile[], userText: string): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    let textParts: string[] = [];

    if (userText) {
      textParts.push(userText);
    }

    if (files.length > 0) {
      for (const file of files) {
        if (file.isImage) {
          // Flush any accumulated text before the image block
          if (textParts.length > 0) {
            blocks.push({ type: 'text', text: textParts.join('\n\n') });
            textParts = [];
          }

          // Read image as base64 and add as inline content block
          try {
            const imageBuffer = fs.readFileSync(file.path);
            const base64Data = imageBuffer.toString('base64');
            const mediaType = this.toImageMediaType(file.mimetype);

            if (mediaType) {
              blocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Data,
                },
              });
              textParts.push(`[Image: ${file.name}]`);
            } else {
              textParts.push(`[Unsupported image format: ${file.name} (${file.mimetype})]`);
            }
          } catch (error) {
            this.logger.error('Failed to read image for inline embedding', { name: file.name, error });
            textParts.push(`[Failed to read image: ${file.name}]`);
          }
        } else if (file.isText) {
          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              textParts.push(`## File: ${file.name}\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\``);
            } else {
              textParts.push(`## File: ${file.name}\n\`\`\`\n${content}\n\`\`\``);
            }
          } catch (error) {
            textParts.push(`[Error reading file: ${file.name}]`);
          }
        } else {
          textParts.push(`[Binary file: ${file.name} (${file.mimetype}, ${file.size} bytes)]`);
        }
      }
    }

    if (!userText && files.length > 0) {
      textParts.push('Please analyze these files and provide insights or assistance based on their content.');
    }

    // Flush remaining text
    if (textParts.length > 0) {
      blocks.push({ type: 'text', text: textParts.join('\n\n') });
    }

    return blocks;
  }

  hasImages(files: ProcessedFile[]): boolean {
    return files.some(f => f.isImage);
  }

  private toImageMediaType(mimetype: string): ImageMediaType | null {
    const supported: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    return supported.includes(mimetype as ImageMediaType) ? (mimetype as ImageMediaType) : null;
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    for (const file of files) {
      if (file.tempPath) {
        try {
          fs.unlinkSync(file.tempPath);
          this.logger.debug('Cleaned up temp file', { path: file.tempPath });
        } catch (error) {
          this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
        }
      }
    }
  }

  getSupportedFileTypes(): string[] {
    return [
      'Images: jpg, png, gif, webp, svg',
      'Text files: txt, md, json, js, ts, py, java, etc.',
      'Documents: pdf, docx (limited support)',
      'Code files: most programming languages',
    ];
  }
}