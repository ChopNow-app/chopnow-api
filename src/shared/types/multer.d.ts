// Minimal type shim for the bits of multer we touch — file upload via NestJS's
// FileFieldsInterceptor. The @nestjs/platform-express dependency bundles multer
// at runtime; this file just makes `Express.Multer.File` reachable to tsc
// without pulling in the full @types/multer package (which kept hanging during
// install on this machine — see notes in Story 2.0 PR).
declare global {
  namespace Express {
    namespace Multer {
      interface File {
        /** Field name specified in the form. */
        fieldname: string;
        /** Filename provided by the user. */
        originalname: string;
        /** Encoding type of the file. */
        encoding: string;
        /** Mime type of the file. */
        mimetype: string;
        /** Size of the file in bytes. */
        size: number;
        /** Buffer containing the entire file. Only present when memory storage is used. */
        buffer: Buffer;
        /** Folder to which the file has been saved. Disk storage only. */
        destination?: string;
        /** Name of the file within `destination`. Disk storage only. */
        filename?: string;
        /** Full path to the uploaded file. Disk storage only. */
        path?: string;
        /** A `Readable` stream of the file. `multer.diskStorage()` only. */
        stream?: NodeJS.ReadableStream;
      }
    }
  }
}

export {};
