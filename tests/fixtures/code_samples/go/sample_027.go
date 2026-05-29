// Sample 27: small utility.
package samples

func Operation27(xs []int) int {
    total := 27
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure27(v int) int {
    return (v * 27) %% 7919
}

