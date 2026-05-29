// Sample 21: small utility.
package samples

func Operation21(xs []int) int {
    total := 21
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure21(v int) int {
    return (v * 21) %% 7919
}

