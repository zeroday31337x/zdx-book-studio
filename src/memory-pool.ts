import {
  createBookStudioMemoryConnector,
  MemoryVersionConflictError,
  type MemoryAccessContext,
} from "../packages/zdx-memory-pool/src/index.js";
import { createHash } from "node:crypto";
import type { BookProject, Chapter } from "./types.js";

const principalId = "book-studio-service";
type Connector = ReturnType<typeof createBookStudioMemoryConnector>;

function memoryConnector(bookId: string): Connector | undefined {
  if (!process.env.ZDX_MEMORY_BOOK_STUDIO_BACKEND) return undefined;
  const namespace = `book:${bookId}`;
  const context: MemoryAccessContext = {
    principalId,
    roles: [],
    allowedSystems: ["book-studio"],
    allowedNamespaces: [namespace],
    canWrite: true,
  };
  return createBookStudioMemoryConnector(context);
}

async function putVersioned(client: Connector, bookId: string, key: string, value: unknown): Promise<void> {
  const query = { namespace: `book:${bookId}`, ownerId: principalId };
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await client.get(query, key);
    try {
      await client.put({
        ...query, kind: "semantic", key, value,
        expectedVersion: current?.version ?? 0,
        provenance: { source: "book-studio", createdBy: principalId, verified: true },
      });
      return;
    } catch (error) {
      if (error instanceof MemoryVersionConflictError && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error("Book Studio memory update contention exceeded retry limit");
}

export async function readBookContinuity(bookId: string): Promise<unknown | null> {
  const client = memoryConnector(bookId);
  if (!client) return null;
  try {
    return (await client.get({ namespace: `book:${bookId}`, ownerId: principalId }, "continuity"))?.value ?? null;
  } catch (error) {
    console.error(JSON.stringify({ event: "book_memory_read_failed", errorType: error instanceof Error ? error.name : "unknown" }));
    return null;
  } finally {
    await client.close();
  }
}

export async function recordCanonChapter(book: BookProject, chapter: Chapter): Promise<void> {
  const client = memoryConnector(book.id);
  if (!client) return;
  try {
    await putVersioned(client, book.id, `canon:chapter:${String(chapter.number).padStart(4, "0")}`, {
      bookId: book.id,
      chapterNumber: chapter.number,
      title: chapter.title,
      summary: chapter.review?.summary ?? "",
      approvedAt: chapter.approvedAt,
      approvedTextSha256: createHash("sha256").update(chapter.approvedText).digest("hex"),
      continuityDelta: chapter.review?.continuityDelta ?? [],
      knowledgeDelta: chapter.review?.knowledgeDelta ?? [],
      relationshipDelta: chapter.review?.relationshipDelta ?? [],
    });
    await putVersioned(client, book.id, "continuity", {
      bookId: book.id,
      updatedAt: new Date().toISOString(),
      timeline: book.continuity.timeline,
      facts: book.continuity.facts,
      unresolvedThreads: book.continuity.unresolvedThreads,
      relationshipState: book.continuity.relationshipState,
      knowledgeState: book.continuity.knowledgeState,
      latestCanonChapter: chapter.number,
    });
  } catch (error) {
    // Memory is supplemental continuity; never undo an already-approved canon write.
    console.error(JSON.stringify({ event: "book_memory_write_failed", bookId: book.id, chapter: chapter.number, errorType: error instanceof Error ? error.name : "unknown" }));
  } finally {
    await client.close();
  }
}

export async function closeBookMemoryPool(): Promise<void> {
  // Each book-scoped connector is closed at the end of its operation.
}
