// A client of a server under NISSE_KERNEL=1: the kernel wire over the home's socket, which starts the server when none
// runs and reconnects when the socket drops.
import { KernelRpcs } from "@nisse/wire"
import { Context, Layer } from "effect"
import * as RpcClient from "effect/rpc/RpcClient"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { protocolLayer } from "../client.ts"
import type { Home } from "../home.ts"

export class KernelClient extends Context.Service<
  KernelClient,
  RpcClient.FromGroup<typeof KernelRpcs, RpcClientError>
>()("nisse/KernelClient") {}

export const kernelClientLayer = (home: Home) =>
  Layer.effect(KernelClient, RpcClient.make(KernelRpcs)).pipe(Layer.provide(protocolLayer(home)))
