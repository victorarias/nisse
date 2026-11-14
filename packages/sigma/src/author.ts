import { userInfo } from "node:os"
import type { Author } from "@sigma/protocol"

/**
 * Who this process acts as: `SIGMA_AUTHOR_ID` and `SIGMA_AUTHOR_NAME`, which a program that starts sigma for someone
 * sets, each falling back to the system's user name.
 */
export const launchAuthor = (): Author => {
  const user = process.env.USER || userInfo().username
  return { id: process.env.SIGMA_AUTHOR_ID || user, name: process.env.SIGMA_AUTHOR_NAME || user }
}
