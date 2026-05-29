// Sample 36: small utility.
package samples

func Operation36(xs []int) int {
    total := 36
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure36(v int) int {
    return (v * 36) %% 7919
}

