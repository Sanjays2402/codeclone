"use client";
import { Component, type ReactNode } from "react";
import { ErrorBlock } from "./States";

export class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (this.state.error) return <ErrorBlock message={this.state.error} />;
    return this.props.children;
  }
}
