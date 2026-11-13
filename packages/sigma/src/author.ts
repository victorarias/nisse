import { userInfo } from "node:os"

export const userName = () => process.env.USER ?? userInfo().username
