import OpenAI from "openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import { Span, initLogger, wrapOpenAI, loadPrompt } from "braintrust";
import { Octokit } from "@octokit/rest";
import { GetResponseTypeFromEndpointMethod } from "@octokit/types";
import { ChatCompletionMessageParam } from "openai/resources/index.mjs";

// Optional, but recommended: run on the edge runtime.
// See https://vercel.com/docs/concepts/functions/edge-functions
export const runtime = "edge";

const logger = initLogger({
  projectName: "Release notes prod",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

const openai = wrapOpenAI(
  new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_API_BASE_URL,
  })
);

type CommitsResponse = GetResponseTypeFromEndpointMethod<
  typeof octokit.rest.repos.listCommits
>;
type Commit = CommitsResponse["data"][number];

// Octokit.js
// https://github.com/octokit/core.js#readme
const octokit: Octokit = new Octokit({
  auth: process.env.GITHUB_ACCESS_TOKEN!,
});

interface CommitInfo {
  url: string;
  html_url: string;
  sha: string;
  commit: {
    author: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
    message: string;
  };
}

async function getCommits(
  span: Span,
  startDate: string,
  endDate: string
): Promise<CommitInfo[]> {
  span.log({
    input: {
      startDate,
      endDate,
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
    },
  });
  const commits: CommitsResponse = await octokit.rest.repos.listCommits({
    owner: process.env.REPO_OWNER!,
    repo: process.env.REPO_NAME!,
    since: startDate,
    until: endDate,
    per_page: 1000,
  });

  const processedCommits = commits.data.map((commit: Commit) => ({
    sha: commit.sha,
    url: commit.url,
    html_url: commit.html_url,
    commit: {
      author: commit.commit.author,
      message: commit.commit.message,
    },
  }));

  span.log({
    output: processedCommits,
  });
  return processedCommits;
}

function flattenChunks(allChunks: Uint8Array[]) {
  const flatArray = new Uint8Array(allChunks.reduce((a, b) => a + b.length, 0));
  for (let i = 0, offset = 0; i < allChunks.length; i++) {
    flatArray.set(allChunks[i], offset);
    offset += allChunks[i].length;
  }
  return new TextDecoder().decode(flatArray);
}

export async function POST(req: Request) {
  const { startDate, endDate } = await req.json();
  const stream = await logger.traced(
    async (span) => {
      console.log("startDate", startDate);
      console.log("endDate", endDate);

      const commits = await span.traced(
        (span) => getCommits(span, startDate, endDate),
        {
          name: "get-commits",
        }
      );

      console.log("HERE");

      const prompt = await loadPrompt({
        projectName: "Release notes prod",
        slug: "release-notes",
      });

      console.log("HERE2");

      // Request the OpenAI API for the response based on the prompt
      const response = await openai.chat.completions.create({
        ...prompt.build({ project: "Braintrust", commits }),
        stream: true,
        seed: 123,
      });

      // Convert the response into a friendly text-stream
      const stream = OpenAIStream(response);

      const allChunks: Uint8Array[] = [];
      const outputStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          allChunks.push(chunk);
          controller.enqueue(chunk);
        },
        async flush(controller) {
          const text = flattenChunks(allChunks);
          span.log({ output: text });
        },
      });

      return stream.pipeThrough(outputStream);
    },
    {
      name: "generate-release-notes",
      event: {
        input: {
          startDate,
          endDate,
        },
      },
    }
  );

  // Respond with the stream
  return new StreamingTextResponse(stream);
}
