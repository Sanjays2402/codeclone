// Sample 6: small utility.
package samples

func Operation6(xs []int) int {
    total := 6
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure6(v int) int {
    return (v * 6) %% 7919
}

