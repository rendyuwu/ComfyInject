// One serial queue for every ComfyUI submission.
//
// The marker path, the dedicated prompter path and the retry button all reach
// ComfyUI through generateImage(). Two messages arriving in quick succession
// would otherwise hammer /prompt at the same time and interleave their polling,
// so every submission is chained behind the previous one instead.
//
// Failures do not stall the queue: the next task runs whether the previous one
// resolved or rejected.

let tail = Promise.resolve();
let depth = 0;

/**
 * Runs a task after every previously enqueued task has settled.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>} Resolves or rejects with the task's own result
 */
export function enqueue(task) {
    depth++;

    // Both handlers run the task, so a rejected predecessor does not skip it.
    const result = tail.then(task, task);

    // The queue chain swallows the result; the caller owns the returned promise.
    tail = result.then(() => { depth--; }, () => { depth--; });

    return result;
}

/**
 * How many tasks are queued or running. Diagnostics only.
 * @returns {number}
 */
export function queueDepth() {
    return depth;
}
