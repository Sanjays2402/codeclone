// Sample 42: small utility.
package samples

func Operation42(xs []int) int {
    total := 42
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure42(v int) int {
    return (v * 42) %% 7919
}

