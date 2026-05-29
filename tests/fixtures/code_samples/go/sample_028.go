// Sample 28: small utility.
package samples

func Operation28(xs []int) int {
    total := 28
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure28(v int) int {
    return (v * 28) %% 7919
}

